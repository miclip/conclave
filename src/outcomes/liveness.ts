/**
 * Whether a child that has gone quiet is working or idle.
 *
 * A watchdog timeout says a turn produced nothing for N seconds. It does not say WHY, and
 * three different causes reach that same line:
 *
 *   the child is working hard   a `go test` with live z3 children, tokens still counting
 *   the child is idle           0% CPU, nothing since the prompt
 *   the provider stopped        the account hit a usage limit; the CLI sits there
 *
 * The first wants "wait", the second wants "continue", the third wants "stop and top up",
 * and two of the three are destructive if applied to the wrong one. Today all three printed
 * `timed_out (uncertain)` and left the operator to work it out.
 *
 * Every operator worked it out the same way: they went and read the process table. Three
 * times in one day, across three people, on two projects — and one of them still guessed
 * wrong and lost a run. That fact is a `ps` away from the orchestrator, which owns the pty
 * and knows the pid, so it was available here all along and offered to nobody. See #43, #45.
 *
 * ## Why sampling rather than a single reading
 *
 * `%cpu` from `ps` is a decaying average, so one reading of a child that has just finished a
 * burst can look busy, and one reading taken between bursts can look idle. Three samples a
 * second apart is enough to tell a process that is doing nothing from one that is pausing
 * between chunks, and cheap enough to spend before a pause a human is about to read.
 *
 * ## It measures a process that has been running a while
 *
 * `%cpu` is CPU time over ELAPSED time, so a process a few milliseconds old is dominated by
 * its own startup and reads as busy however idle it is about to be. That is not a problem
 * where this is used -- a pause fires after minutes of silence, by which point the average
 * has long since decayed -- but it is a real precondition, and it broke a release when a
 * test sampled a `sleep` the instant it spawned and got 0.8%.
 *
 * ## What it deliberately does not conclude
 *
 * It reports what it measured; it does not decide the turn's fate. A child at 0% CPU may be
 * waiting on a socket, which is what a provider stall looks like from outside — so "idle"
 * here means "not computing", never "dead". The verdict model already has words for how
 * strongly a thing is believed, and inventing a confident answer from a weak signal is the
 * failure this project keeps finding in its own diagnostics.
 */

import { execFileSync } from 'node:child_process'

/**
 * Below this, a child is not doing work.
 *
 * Was 0.5, with a comment asserting that was "comfortably below anything actually running a
 * model turn" -- asserted, never measured. An idle Claude Code TUI sits above it: it redraws
 * a spinner and services timers, and an operator watched one hold just under 1% for nearly
 * four hours while conclave insisted it was working.
 *
 * 3 is calibrated against both ends of the same day's readings rather than invented: an idle
 * session at ~1%, and a working one at 12-17% while its turn was demonstrably producing
 * files. It is a heuristic and the number will be wrong for some machine; what must not
 * happen again is a number chosen by intuition and then described as though it were not.
 */
export const IDLE_CPU_PERCENT = 3

export interface ChildLiveness {
  pid: number
  /** Whether the process still exists at all. */
  alive: boolean
  /** CPU percentages, in sample order. Empty when the process was gone throughout. */
  samples: number[]
  /**
   * True when every sample was effectively zero.
   *
   * "Not computing", never "dead" — a process blocked on a socket reads the same way, and
   * that is exactly what a provider that stopped answering looks like from out here.
   */
  idle: boolean
}

/** One reading, or undefined if the process is gone. */
function cpuOf(pid: number): number | undefined {
  try {
    const out = execFileSync('ps', ['-o', '%cpu=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!out) return undefined
    const n = Number(out.split('\n')[0]?.trim())
    return Number.isFinite(n) ? n : undefined
  } catch {
    // A dead process, or a platform whose `ps` does not speak this. Both mean "no reading",
    // and neither is worth failing a pause over.
    return undefined
  }
}

/**
 * Sample a child's CPU a few times.
 *
 * Bounded and small: this runs while an operator waits to be told what happened, and a
 * diagnosis that takes longer than the decision it informs is not worth having.
 */
export async function sampleLiveness(
  pid: number,
  opts: { samples?: number; everyMs?: number } = {},
): Promise<ChildLiveness> {
  const count = opts.samples ?? 3
  const everyMs = opts.everyMs ?? 400
  const samples: number[] = []
  for (let i = 0; i < count; i++) {
    const c = cpuOf(pid)
    if (c !== undefined) samples.push(c)
    if (i < count - 1) await new Promise((r) => setTimeout(r, everyMs))
  }
  const alive = samples.length > 0
  return { pid, alive, samples, idle: alive && samples.every((c) => c < IDLE_CPU_PERCENT) }
}

/**
 * The evidence line an operator reads at a pause.
 *
 * Phrased as a measurement, not a verdict. "still running" and "idle" are what was seen;
 * what to do about it stays the operator's call, which is the whole point of a pause.
 */
export function describeLiveness(l: ChildLiveness, emittedSinceSend: number): string {
  if (!l.alive) return `child pid ${l.pid} is gone; the CLI exited without a terminal signal`
  const cpu = l.samples.map((c) => `${c.toFixed(1)}%`).join(', ')
  const since =
    emittedSinceSend === 0
      ? 'nothing at all since the prompt was sent'
      : `${emittedSinceSend} event(s) since the prompt was sent`
  return l.idle
    ? `child pid ${l.pid} is alive but not computing (cpu ${cpu}) — ${since}. ` +
        `Idle is not dead: a CLI waiting on a provider that stopped answering looks like this`
    : `child pid ${l.pid} is still working (cpu ${cpu}) — ${since}. ` +
        `Continuing sends into a live turn, which neither CLI accepts`
}
