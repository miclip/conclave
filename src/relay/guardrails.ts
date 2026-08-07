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

export interface Ceilings {
  /** Wall-clock ceiling in milliseconds. Absent means no limit. */
  maxDurationMs?: number | undefined
  /** Total turns across all participants. Absent means no limit. */
  maxTurns?: number | undefined
}

export interface CeilingBreach {
  kind: 'duration' | 'turns'
  limit: number
  reached: number
  detail: string
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
export function breached(
  ceilings: Ceilings,
  now: { elapsedMs: number; turns: number },
): CeilingBreach | undefined {
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
  return undefined
}
