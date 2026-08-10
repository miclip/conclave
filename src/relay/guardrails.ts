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
export function preflightRefusals(cwd: string, opts: { force?: boolean } = {}): PreflightRefusal[] {
  const out: PreflightRefusal[] = []
  if (!opts.force && !insideGitRepo(cwd)) {
    out.push({
      reason: `${cwd} is not inside a git repository`,
      remedy:
        'Conclave attributes work by diffing the tree, and rotation verifies a transfer against ' +
        'it, so both are meaningless here. Run from a repository, or pass --force to start anyway.',
    })
  }
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
  /** Wall-clock ceiling in milliseconds. Absent means no limit. Consumable: breaches on `>=`. */
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
 * `--check-concurrency N`: how many check sections may run at once, run-wide.
 *
 * Shared by both front-ends for the reason `ceilingsFrom` is, and read into `RelayOptions`
 * unchanged. Absent is `undefined`, which is the lane's own default of one slot -- absent must
 * stay behaviourless, and a front-end that wrote `1` into the options would make every default
 * run look like one that had configured serialisation on purpose.
 *
 * Unlike the ceiling flags this one VALIDATES, and the difference is what the value does. A
 * ceiling that parses to `NaN` never fires, which is the same as not setting it; a slot count
 * that parses to `NaN` is compared against a live count and the lane stops meaning anything.
 * `0` is refused rather than read as "unlimited": an operator who typed it meant one of two
 * opposite things, and picking one is worse than saying so.
 *
 * Returns `{ refused }` rather than throwing, so the caller decides where in its own order the
 * refusal happens -- both blocks have work that must not be done on the way out of a run that
 * is not going to start.
 */
export function checkConcurrencyFrom(
  raw: string | undefined,
): { lanes?: number | undefined; refused?: string } {
  if (!raw) return {}
  // Digits only, as `--older-than` does it: `Number('')` is 0 and `parseInt('4 lanes')` is 4,
  // and both readings turn a typo into a configuration nobody chose.
  if (!/^\d+$/.test(raw.trim()) || Number(raw.trim()) < 1) {
    return {
      refused:
        `--check-concurrency takes a whole number of check slots, at least 1; got "${raw}". ` +
        `It is the number of check commands allowed to run at once across the whole run — 1 ` +
        `serialises them, which is the default and is what a suite that binds ports or fixture ` +
        `directories needs.`,
    }
  }
  return { lanes: Number(raw.trim()) }
}

/**
 * Whether a ceiling has been passed.
 *
 * Checked at turn boundaries rather than by a timer, because a run cannot be interrupted
 * mid-turn without discarding the turn's work — the same reason `#exchange` has no timeout of
 * its own. So a duration ceiling stops the run at the first boundary AFTER the limit, and the
 * report says the elapsed figure rather than the limit, because a reader comparing the two
 * needs both.
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
      detail: `time ceiling reached: ${s(now.elapsedMs)} elapsed of a maximum ${s(ceilings.maxDurationMs)}`,
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
