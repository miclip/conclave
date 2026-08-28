/**
 * Refusing to start a run that should not start, and stopping one that has gone too long.
 *
 * Both exist because the expensive path is the easy one. A real relay was once started in
 * `/tmp/ignoretest` purely to check a single log line: two agent sessions spawned and billed
 * before it was killed. Before that, `conclave relay --help` parsed `--help` as the GOAL and
 * billed for the answer — the one invocation someone types when they do not know what a
 * command does was the one that spent their quota.
 *
 * A human makes each of those mistakes once. An agent operator makes them repeatedly, because
 * starting a run is cheap to TYPE and the cost is invisible until it has been paid.
 *
 * ## Ceilings are not only cost control
 *
 * The rotation experiments turn on long runs, and "it ran for two hours" has to be a
 * deliberate setting rather than an accident. A ceiling that must be raised on purpose puts
 * the intended run length INTO the record, where `spikes/experiments/` currently has to infer
 * it after the fact.
 *
 * So a ceiling that is hit is reported, loudly, and exits non-zero. A silent stop is
 * indistinguishable from a run that simply finished, which is the ambiguity `rotationWatch`
 * was built to remove and would be reintroduced here.
 */

import { execFileSync } from 'node:child_process'
import { statfsSync } from 'node:fs'
import { outstanding } from '../workspace/mutationMarker.ts'

export interface PreflightRefusal {
  reason: string
  /** What the operator can do about it. A diagnostic with no action attached is half a message. */
  remedy: string
}

/**
 * Whether `dir` is inside a git repository.
 *
 * Exported so the check is testable without a temp repository per case.
 */
export function insideGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Free bytes on the volume holding `dir`, or `undefined` if the reading cannot be taken.
 *
 * Exported so the thresholds below are testable without filling a volume, which is the same
 * reason `insideGitRepo` is exported.
 *
 * `undefined` rather than 0 for an unavailable reading, and the distinction is the whole
 * contract: `statfs` is not available on every platform Node runs on, and a guard that cannot
 * read the disk must not refuse the run. Returning 0 would make an unsupported platform look
 * exactly like a full one and would block every run on it.
 */
export function freeBytes(dir: string): number | undefined {
  try {
    const s = statfsSync(dir)
    // `bavail`, not `bfree`: the blocks available to THIS user, not the ones that exist. On a
    // volume with reserved blocks the two differ by gigabytes, and a run cannot spend the
    // reserve.
    return s.bavail * s.bsize
  } catch {
    return undefined
  }
}

/**
 * Below this, a run is refused. Above it but below `DISK_WARN_BYTES`, it is warned about.
 *
 * A run is not one write. It creates a worktree per seat, a transcript that grows for as long
 * as the run lasts, and a session record written on every status change -- so the question at
 * startup is not "can the next write land" but "is there room for a run's worth of writes",
 * and those are different numbers by orders of magnitude.
 *
 * The figures are deliberately unfussy. There is no way to know what a given run will need,
 * so precision here would be false: the floor is set where a run is CERTAIN not to finish, and
 * the warning where finishing is a gamble the operator should get to make knowingly.
 */
export const DISK_FLOOR_BYTES = 512 * 1024 * 1024
/** @see DISK_FLOOR_BYTES */
export const DISK_WARN_BYTES = 2 * 1024 * 1024 * 1024

/** A condition worth saying out loud that is not, on its own, a reason to refuse. */
export interface PreflightWarning {
  reason: string
  remedy: string
}

/**
 * Conditions the operator should know about before a run starts, none of which refuse it.
 *
 * Separate from `preflightRefusals` rather than a flag on it, because the caller does
 * different things with them: a refusal ends the process and a warning does not. Folding both
 * into one list would put that distinction in the CALLER, where forgetting it turns every
 * warning into a fatal error or every refusal into a printed line.
 */
export function preflightWarnings(
  cwd: string,
  opts: { readFree?: (dir: string) => number | undefined } = {},
): PreflightWarning[] {
  const out: PreflightWarning[] = []
  const w = spaceWarning(cwd, (opts.readFree ?? freeBytes)(cwd))
  if (w) out.push(w)
  const m = mutationWarning(cwd)
  if (m) out.push(m)
  return out
}

/**
 * A tree holding a file that is deliberately broken and was never put back (#181).
 *
 * Said, not refused, and that is deliberate: a marker that blocked work would be deleted by
 * the first person it inconvenienced, and then it guards nothing. `sessionLock.read` reached
 * the same conclusion about a stale lock for the same reason.
 *
 * Only the DIRTY markers. One whose file already matches its recorded original is a marker
 * that outlived its restore -- untidy, harmless, and not worth a line in front of every run.
 * The case worth interrupting someone for is a defect sitting in the tree right now.
 */
export function mutationWarning(cwd: string): PreflightWarning | undefined {
  let dirty: ReturnType<typeof outstanding>
  try {
    dirty = outstanding(cwd).filter((m) => m.dirty)
  } catch {
    // A guard that cannot read its own bookkeeping must not stop a run. Same rule as an
    // unreadable volume above.
    return undefined
  }
  if (dirty.length === 0) return undefined
  const named = dirty.map((m) => m.marker.path).join(', ')
  return {
    reason: `${dirty.length} file(s) are deliberately mutated and were never restored: ${named}`,
    remedy:
      'A mutation left by a crash looks exactly like work in progress, which is how #180 ' +
      'nearly committed a reverted fix. `conclave mutations` says what each one was for, ' +
      'and `conclave mutations restore <path>` puts the original back from the stored copy.',
  }
}

/**
 * The warning band, as a decision about a reading rather than about a volume.
 *
 * Split from the reading so the thresholds are testable without filling a disk -- the same
 * reason `insideGitRepo` is exported. Every branch below is reachable from a plain number.
 */
export function spaceWarning(cwd: string, free: number | undefined): PreflightWarning | undefined {
  // An unavailable reading warns about nothing. See `freeBytes` for why `undefined` is not 0.
  if (free === undefined || free < DISK_FLOOR_BYTES || free >= DISK_WARN_BYTES) return undefined
  return {
    reason: `${gib(free)} free on the volume holding ${cwd}`,
    remedy:
      'A run writes a worktree per seat plus a growing transcript. This may not be enough ' +
      'to finish on. Freeing space now is cheaper than losing the run partway.',
  }
}

/**
 * The refusal floor, as a decision about a reading. @see spaceWarning
 *
 * Below the floor and above it are the only two cases; the band between floor and warning is
 * `spaceWarning`'s, and the two are deliberately exclusive so a single reading cannot produce
 * both a refusal and a warning saying softer versions of the same thing.
 */
export function spaceRefusal(cwd: string, free: number | undefined): PreflightRefusal | undefined {
  if (free === undefined || free >= DISK_FLOOR_BYTES) return undefined
  return {
    reason: `only ${gib(free)} free on the volume holding ${cwd}`,
    remedy:
      'A run writes a worktree per seat, a transcript, and a session record on every status ' +
      'change; there is not room for that here. Free some space, or pass --force to start ' +
      'anyway. See #180: a run that fills the volume dies mid-flight, and what it was doing ' +
      'when it died is the part that is lost.',
  }
}

/**
 * Whether `err` is, anywhere in its cause chain, a volume that has run out of room.
 *
 * The chain walk is the point. By the time a full disk reaches a caller it has usually been
 * wrapped at least once -- a write failure surfacing as a transcript error, a spawn failure,
 * a JSON dump that could not be flushed -- and the `code` that names the real condition is on
 * the innermost error, not the one that was thrown. Matching only the outermost is why this
 * arrived as a stack dump rather than a diagnosis (#180).
 *
 * `EDQUOT` counts: a quota that is exhausted is a full volume from the run's point of view,
 * and the operator's remedy is the same one.
 *
 * The depth cap is not a guess about how deep wrapping goes -- it is there because `cause` is
 * an ordinary property that can point back at an error already seen, and a cycle here would
 * hang the one path whose whole job is to fail cleanly.
 */
export function outOfSpace(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 16; depth += 1) {
    const code = (e as { code?: unknown }).code
    if (code === 'ENOSPC' || code === 'EDQUOT') return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

/** Bytes as GiB to one decimal, for a message a person reads rather than parses. */
function gib(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
}

/**
 * Reasons not to start, checked before anything is spawned.
 *
 * A directory with no repository is the strongest signal available that a run was started in
 * the wrong place. It is not proof — someone may genuinely want an agent loose in a scratch
 * directory — so it is forceable rather than absolute. But the default matters: the failure
 * being guarded is an operator who did not intend to start a run at all, and that operator
 * will not be passing a force flag.
 *
 * Deliberately NOT a check for an empty directory or a missing package.json. Conclave is
 * meant to work in a project it has never seen, and `config install` exists precisely so a
 * fresh checkout needs nothing. Refusing on those would break the supported case to guard an
 * unsupported one.
 */
export function preflightRefusals(
  cwd: string,
  // `readFree` is a seam, and it injects the READING rather than a number on purpose: a number
  // would make "no override given" and "the volume could not be read" the same `undefined`,
  // and those two must not collapse -- the second is the case that must never refuse.
  opts: { force?: boolean; readFree?: (dir: string) => number | undefined } = {},
): PreflightRefusal[] {
  const out: PreflightRefusal[] = []
  if (!opts.force && !insideGitRepo(cwd)) {
    out.push({
      reason: `${cwd} is not inside a git repository`,
      remedy:
        'Conclave attributes work by diffing the tree, and rotation verifies a transfer against ' +
        'it, so both are meaningless here. Run from a repository, or pass --force to start anyway.',
    })
  }
  // AFTER the repository check, so an operator who is in the wrong directory entirely is told
  // that first. Being out of disk in a directory you did not mean to run in is the less useful
  // half of the answer.
  //
  // Forceable for the same reason the repository check is: the reading is evidence, not proof.
  // A volume that reports little free space can still be the right place to run -- and the
  // operator who passes --force has been told the number and has decided.
  const space = opts.force ? undefined : spaceRefusal(cwd, (opts.readFree ?? freeBytes)(cwd))
  if (space) out.push(space)
  return out
}

/**
 * The ceilings a run can be given. Every field is optional, and absent means NO LIMIT.
 *
 * "Absent is behaviourless" is load-bearing rather than a convenience. A default that bounds a
 * run which is unbounded today would change what an existing invocation does without anyone
 * asking for it, and a ceiling nobody set is exactly the ceiling nobody would think to raise.
 *
 * ## Two kinds of quantity, and they do not compare the same way
 *
 * `maxTurns` and `maxDurationMs` are CONSUMABLES: an allowance the run spends and cannot get
 * back. Reaching the number means the allowance is gone, so they breach on `>=`.
 *
 * `maxQueueDepth` and `maxConcurrentSeats` are GAUGES: an instantaneous reading of how much is
 * outstanding right now, which goes up and down. `maxConcurrentSeats: 2` has to permit two
 * seats -- a ceiling that stopped the run at the number it was told to allow would be read as
 * a bug by anyone who set it -- so they breach on `>`, when the reading EXCEEDS the ceiling.
 *
 * The asymmetry is deliberate and is the one thing about this type worth reading twice.
 */
export interface Ceilings {
  /**
   * Duration ceiling in milliseconds. Absent means no limit. Consumable: breaches on `>=`.
   *
   * ACTIVE run time, not wall-clock: time the run spent suspended at a pause, waiting for an
   * operator to decide, is not counted against it (#112). The reason is in `Relay#pausedMs`,
   * along with what still bounds a run that never makes progress.
   */
  maxDurationMs?: number | undefined
  /** Total turns across all participants. Absent means no limit. Consumable: breaches on `>=`. */
  maxTurns?: number | undefined
  /**
   * The most admitted work that may be waiting for a seat at once. Absent means no limit.
   *
   * A gauge, so it breaches on `>`. Counts tasks the advisor's decisions have admitted but
   * which no seat has taken yet -- `admitted` and `ready` in `TaskState` terms. Work already
   * running is not queued and is not counted here; `maxConcurrentSeats` is that question.
   */
  maxQueueDepth?: number | undefined
  /**
   * The most seats that may be working at once. Absent means no limit.
   *
   * A gauge, so it breaches on `>`. Counts seats holding a task that has been assigned and has
   * not yet reported. A seat in the integration boundary is deliberately NOT counted: it is
   * occupied but no agent is running on it, and a concurrency ceiling is about work in flight.
   */
  maxConcurrentSeats?: number | undefined
}

/** What the run looked like when the ceilings were checked. Every field is a real reading. */
export interface CeilingState {
  /** Time spent RUNNING since the window opened; suspended intervals are already deducted. */
  elapsedMs: number
  turns: number
  queueDepth: number
  concurrentSeats: number
}

export interface CeilingBreach {
  kind: 'duration' | 'turns' | 'queue_depth' | 'concurrent_seats'
  limit: number
  reached: number
  detail: string
}

/**
 * Build `Ceilings` from raw flag strings, or `undefined` if none were given.
 *
 * Shared by both front-ends ON PURPOSE. `--turn-timeout` reaching only the console (#36) and
 * `--record` reaching neither (#69) were both a value parsed in one command block and built
 * into options in that same block, where the other copy could differ or fail to exist. Each
 * block still calls `flag()` itself -- the pinned flag sets read the block, and a flag parsed
 * out of sight of them is a flag that silently leaves the guarded surface -- but what happens
 * to the parsed value afterwards is written once, here, so the two cannot disagree about it.
 *
 * Returning `undefined` rather than `{}` for "none given" keeps absent behaviourless at the
 * option level too: `ceilings: {}` is a run with a ceilings object that limits nothing, which
 * reads in a status document as though someone configured one.
 */
export function ceilingsFrom(raw: {
  maxTurns?: string | undefined
  maxMinutes?: string | undefined
  maxQueueDepth?: string | undefined
  maxConcurrentSeats?: string | undefined
}): Ceilings | undefined {
  const ceilings: Ceilings = {
    ...(raw.maxTurns ? { maxTurns: Number(raw.maxTurns) } : {}),
    ...(raw.maxMinutes ? { maxDurationMs: Number(raw.maxMinutes) * 60_000 } : {}),
    ...(raw.maxQueueDepth ? { maxQueueDepth: Number(raw.maxQueueDepth) } : {}),
    ...(raw.maxConcurrentSeats ? { maxConcurrentSeats: Number(raw.maxConcurrentSeats) } : {}),
  }
  return Object.keys(ceilings).length > 0 ? ceilings : undefined
}

/**
 * Every ceiling a run is bound by, with the ones nobody set said explicitly.
 *
 * The reporting shape, not the configuration shape, and the difference is the whole point.
 * `Ceilings` omits what was not configured because absent there must stay BEHAVIOURLESS. Here
 * absent would be the defect: #119 was a run that stopped at an advisor budget of 8 while the
 * operator believed they had raised it to 40, and nothing in the banner, the console or
 * `status --json` said what any ceiling was. A key that vanishes when a limit is unset cannot
 * be told from a key a reader forgot to look for, so every field is present and `null` means
 * "no limit". `RunDeadlines.configuredAbsoluteMs` reports the same way for the same reason.
 *
 * `advisorTurns` is the ceiling the issue is actually about and it is never null: a run always
 * has an advisor budget, even when nobody named one (`DEFAULT_ADVISOR_TURNS`). It is here
 * rather than in `Ceilings` because it is not a `Ceilings` field -- it bounds how many times
 * the advisor steers, not the run as a resource -- and this type is what an operator means when
 * they ask what stops the run.
 */
export interface RunCeilings {
  /** Advisor turns, from `--rounds`. Never null: every run has one, set or defaulted. */
  advisorTurns: number
  /** `--max-turns`. Turns across all participants. */
  maxTurns: number | null
  /** `--max-minutes`, in milliseconds as it is configured and checked. */
  maxDurationMs: number | null
  /** `--max-queue-depth`. */
  maxQueueDepth: number | null
  /** `--max-concurrent-seats`. */
  maxConcurrentSeats: number | null
}

/**
 * The configuration as it will be REPORTED.
 *
 * One reader, for the same reason `ceilingsFrom` is one: the launch banner, the console
 * banner and `status --json` all answer "what bounds this run", and three places computing it
 * would eventually disagree about which ceilings exist. `advisorTurns` arrives as a resolved
 * number rather than as `RelayOptions`, so this module keeps knowing nothing about the relay.
 */
export function effectiveCeilings(run: {
  advisorTurns: number
  ceilings?: Ceilings | undefined
}): RunCeilings {
  const c = run.ceilings
  return {
    advisorTurns: run.advisorTurns,
    maxTurns: c?.maxTurns ?? null,
    maxDurationMs: c?.maxDurationMs ?? null,
    maxQueueDepth: c?.maxQueueDepth ?? null,
    maxConcurrentSeats: c?.maxConcurrentSeats ?? null,
  }
}

/**
 * The same facts on one line, named by the FLAG that sets each one.
 *
 * Flag spellings rather than field names, because the reader is an operator deciding whether
 * what they typed took effect -- and #119 is precisely two adjacent flags bounding different
 * things. `--rounds 8 · --max-turns 40` is the line that would have shown, in three words, that
 * the budget raised was not the budget meant.
 *
 * Written with the leading dashes so each item reads as the flag it is. `--rounds` is a flag
 * name, not a claim that an advisor turn is a "round" -- the vocabulary that rename retired,
 * and which `advisorTurns.test.ts` holds the rest of the product to.
 *
 * Unset ceilings are printed as `none` rather than omitted. A line that listed only what was
 * configured would be empty on the run that lost 488 uncommitted insertions, which is the run
 * this exists for.
 */
export function ceilingSummary(c: RunCeilings): string {
  const minutes = c.maxDurationMs === null ? 'none' : String(c.maxDurationMs / 60_000)
  return [
    `--rounds ${c.advisorTurns}`,
    `--max-turns ${c.maxTurns ?? 'none'}`,
    `--max-minutes ${minutes}`,
    `--max-queue-depth ${c.maxQueueDepth ?? 'none'}`,
    `--max-concurrent-seats ${c.maxConcurrentSeats ?? 'none'}`,
  ].join(' · ')
}

/**
 * Whether a ceiling has been passed.
 *
 * Checked at turn boundaries rather than by a timer, because a run cannot be interrupted
 * mid-turn without discarding the turn's work — the same reason `#exchange` has no timeout of
 * its own. So a duration ceiling stops the run at the first boundary AFTER the limit, and the
 * report says the elapsed figure rather than the limit, because a reader comparing the two
 * needs both.
 *
 * `elapsedMs` arrives already net of time the run spent paused; this function is handed a
 * reading and does not know how it was taken. The caller that takes it is `Relay#ceilingState`,
 * and `Relay#pausedMs` is where the deduction is argued for (#112).
 */
export function breached(ceilings: Ceilings, now: CeilingState): CeilingBreach | undefined {
  if (ceilings.maxTurns !== undefined && now.turns >= ceilings.maxTurns) {
    return {
      kind: 'turns',
      limit: ceilings.maxTurns,
      reached: now.turns,
      detail: `turn ceiling reached: ${now.turns} of a maximum ${ceilings.maxTurns}`,
    }
  }
  if (ceilings.maxDurationMs !== undefined && now.elapsedMs >= ceilings.maxDurationMs) {
    const s = (ms: number) => `${Math.round(ms / 1000)}s`
    return {
      kind: 'duration',
      limit: ceilings.maxDurationMs,
      reached: now.elapsedMs,
      // Says WHICH time, because since #112 it is no longer the wall clock. A run that paused
      // for an hour and then ended on a five-minute ceiling reads as arithmetic nobody can
      // check unless the line names what it counted.
      detail:
        `time ceiling reached: ${s(now.elapsedMs)} of active run time of a maximum ` +
        `${s(ceilings.maxDurationMs)} (time paused for an operator is not counted)`,
    }
  }
  // The gauges, on `>` rather than `>=`. See `Ceilings`: these read what is outstanding right
  // now, and a run told to allow N must be allowed to reach N.
  if (ceilings.maxQueueDepth !== undefined && now.queueDepth > ceilings.maxQueueDepth) {
    return {
      kind: 'queue_depth',
      limit: ceilings.maxQueueDepth,
      reached: now.queueDepth,
      detail:
        `queue ceiling exceeded: ${now.queueDepth} task(s) waiting for a seat, ` +
        `above a maximum of ${ceilings.maxQueueDepth}`,
    }
  }
  if (ceilings.maxConcurrentSeats !== undefined && now.concurrentSeats > ceilings.maxConcurrentSeats) {
    return {
      kind: 'concurrent_seats',
      limit: ceilings.maxConcurrentSeats,
      reached: now.concurrentSeats,
      detail:
        `concurrency ceiling exceeded: ${now.concurrentSeats} seat(s) working, ` +
        `above a maximum of ${ceilings.maxConcurrentSeats}`,
    }
  }
  return undefined
}
