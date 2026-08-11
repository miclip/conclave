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
 *
 * ## Three readings, because two of them were one word away from a lie
 *
 * `idle` requires EVERY sample below the line, and that asymmetry stays: a process between
 * bursts of real work must not be called idle, and it was chosen after a run was lost to the
 * opposite mistake. What was wrong was the other half of the same `if`. Anything that was not
 * idle was announced as "still working", so `0.3%, 0.2%, 7.2%` with three events over twelve
 * minutes — a rejected model doing nothing at all — was reported as a live turn, and the
 * operator was told to wait for work that was never going to arrive (#83).
 *
 * "Still working" is an assertion. A mixed sample is not evidence for it, and neither is it
 * evidence against. So the samples now say one of three things, and the mixed case says so in
 * those words rather than being rounded up to the confident end. The EVENT COUNT is an input
 * to that sentence rather than a clause tacked onto it: near-silence alongside a single burst
 * is the shape of a child that is not making progress, and it is what an operator needs in
 * order to go and look at the right thing.
 *
 * The conservative half is untouched everywhere it decides anything. A mixed reading still
 * refuses `/continue` and still offers `wait`, because continuing SENDS and a burst may be a
 * turn. What changed is that the operator is told what was actually measured before they
 * choose, instead of being handed a verdict the numbers do not support.
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

/**
 * At or below this many events since the prompt, a child has produced next to nothing.
 *
 * Unmeasured, and labelled as such rather than dressed up — which is the lesson of the number
 * above. A turn that is doing anything emits events continuously: tool calls, chunks of
 * output, a hook firing. Single digits is "next to nothing" by a wide enough margin that the
 * exact cut does not have to be right to separate that from a turn in flight.
 *
 * It changes WORDING and nothing else. `idle` does not consult it, the `/continue` refusal
 * does not consult it, and no reading is made less conservative by it. A number chosen by
 * intuition may inform how a measurement is described; it may not decide.
 */
export const QUIET_EVENT_COUNT = 5

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
 * What a set of samples supports — which is not the same as what the child is doing.
 *
 * `mixed` is the one that had no name before, and it is the commonest interesting case: a
 * process between bursts and a process that twitched once look identical from three readings.
 * Naming it is the whole of #83, because the alternative was to fold it into `working` and
 * announce a live turn on the strength of one sample.
 */
export type LivenessReading = 'gone' | 'not_computing' | 'working' | 'mixed'

/**
 * Which of the three a reading is.
 *
 * Restated from `samples` rather than read off `idle`, so the reading cannot contradict the
 * numbers printed beside it. It is the same rule: `not_computing` is every sample below the
 * line, which is exactly what `sampleLiveness` set `idle` on.
 */
export function readingOf(l: ChildLiveness): LivenessReading {
  if (!l.alive) return 'gone'
  if (l.samples.every((c) => c < IDLE_CPU_PERCENT)) return 'not_computing'
  if (l.samples.every((c) => c >= IDLE_CPU_PERCENT)) return 'working'
  return 'mixed'
}

/**
 * The headline phrase for each reading a live child can have.
 *
 * Constants because two things read them: the sentence below, and `reportsChildOnCpu`, which
 * the relay uses to decide whether `wait` is a real option at a pause. That used to be a
 * regex over the prose written in one place and matched in another, so the first reading to
 * be phrased differently would have silently taken `wait` off the menu — in the mixed case,
 * where the non-destructive option is worth the most.
 */
const PHRASE = {
  not_computing: 'is alive but not computing',
  working: 'is still working',
  /** Mixed, mostly below the line: the shape #83 was raised about. */
  barely: 'is barely running',
  /** Mixed, mostly above it: a working child with a gap in the samples. */
  bursts: 'is working in bursts',
} as const

/** The phrases that report a child with something on the CPU, mixed included. */
const ON_CPU = [PHRASE.working, PHRASE.barely, PHRASE.bursts]

/**
 * Whether an evidence line reports a child that had CPU in at least one sample.
 *
 * For callers deciding what to OFFER rather than what to say — the pause menu's `wait`. Reads
 * the line the operator reads, so the option and the reason for it cannot disagree.
 */
export function reportsChildOnCpu(evidence: string): boolean {
  return ON_CPU.some((phrase) => evidence.includes(`${phrase} (cpu `))
}

/**
 * The evidence line an operator reads at a pause.
 *
 * Phrased as a measurement, not a verdict. The three readings are what was seen; what to do
 * about it stays the operator's call, which is the whole point of a pause.
 *
 * `emittedSinceSend` is `undefined` where no count was taken alongside the sample. That is
 * not the same as zero, and it used to be spelled as zero by the `/continue` guard, which
 * samples the child fresh and has no matching count to pair with it — so every refusal said
 * "nothing at all since the prompt was sent" about a number nobody had looked at. Harmless
 * while the count was decoration; not harmless now that it is an input.
 */
export function describeLiveness(l: ChildLiveness, emittedSinceSend: number | undefined): string {
  if (!l.alive) return `child pid ${l.pid} is gone; the CLI exited without a terminal signal`
  const cpu = l.samples.map((c) => `${c.toFixed(1)}%`).join(', ')
  const since =
    emittedSinceSend === undefined
      ? 'no output count was taken with this reading'
      : emittedSinceSend === 0
        ? 'nothing at all since the prompt was sent'
        : `${emittedSinceSend} event(s) since the prompt was sent`
  const head = (phrase: string): string => `child pid ${l.pid} ${phrase} (cpu ${cpu}) — ${since}. `
  const reading = readingOf(l)
  if (reading === 'not_computing') {
    return (
      head(PHRASE.not_computing) +
      `Idle is not dead: a CLI waiting on a provider that stopped answering looks like this`
    )
  }
  if (reading === 'working') {
    return head(PHRASE.working) + `Continuing sends into a live turn, which neither CLI accepts`
  }
  const low = l.samples.filter((c) => c < IDLE_CPU_PERCENT).length
  const high = l.samples.length - low
  // The output half of the judgement. Near-silence does not make a mixed sample idle -- it
  // makes "still working" the less likely of the two readings, and says so in those terms.
  const output =
    emittedSinceSend === undefined
      ? `No output count was taken here, so the split is all there is to read.`
      : emittedSinceSend <= QUIET_EVENT_COUNT
        ? `With that little output the likelier reading is a child making no progress, though a ` +
          `sample above the line is not proof of a stall either.`
        : `Output is still arriving, so the low samples read as gaps between bursts.`
  return (
    head(low > high ? PHRASE.barely : PHRASE.bursts) +
    `The samples disagree: ${low} below ${IDLE_CPU_PERCENT}% and ${high} at or above. ` +
    `${output} Continuing still sends into whatever produced the high sample, which neither ` +
    `CLI accepts mid-turn`
  )
}
