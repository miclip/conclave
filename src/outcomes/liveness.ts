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
 *
 * ## A measurement without a time is not a measurement
 *
 * Everything above is about what the samples SUPPORT. #101 is about something one step back:
 * how old they are. A pause captured one reading and then replayed it forever, so an operator
 * polling `conclave status --json` was told `is still working (cpu 3.3%, 5.1%, 3.5%)` by a
 * line measured minutes earlier, about a child that had since gone quiet at 0.2%. They waited
 * out a turn that had already ended, twice in one day, and then aborted a run they could have
 * continued.
 *
 * Two things follow, and they are separate:
 *
 *   - every `ChildLiveness` carries `measuredAt`, and every sentence built from one says so.
 *     A reader can discount an old measurement; they cannot discount one that looks current,
 *     and until now nothing on the line said which it was.
 *   - the reading is RE-MEASURED while the pause lasts, boundedly, and the line says how many
 *     times and whether it is still updating. See `LIVENESS_REFRESH_EVERY_MS` below and
 *     `#refreshPauseLiveness` in `src/relay/relay.ts`, which owns the loop.
 *
 * The bound is the part that needs saying out loud: refreshing stops, and a line that stopped
 * updating without saying so would be the original defect with a fresher number in it. So the
 * final refresh marks itself final, and from then on the timestamp is the whole story.
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

/**
 * How often a paused run re-measures the child behind its liveness evidence.
 *
 * Long enough that the sampling is invisible -- three `ps` calls 400ms apart, twice a minute --
 * and short enough that a turn which ends while the operator is reading the pause is reflected
 * before they have finished deciding. The failure #101 describes took minutes to matter, not
 * seconds.
 */
export const LIVENESS_REFRESH_EVERY_MS = 30_000

/**
 * How many times, at most. After this the evidence stops updating and says so.
 *
 * 60 at the interval above is thirty minutes, chosen against the one deadline the product
 * already has: `/wait` defaults to fifteen (`src/repl/session.ts:1615`), so the refresh has to
 * outlive a default wait or an operator who took the non-destructive option would find the
 * evidence frozen underneath them at the moment they came back to it. Twice that is the margin.
 *
 * Bounded rather than unbounded, deliberately. Not for the cost -- 180 `ps` calls over half an
 * hour is nothing -- but because an unattended pause can last days, and a background timer
 * re-measuring a child nobody is reading about is a thing running for no reader. Thirty minutes
 * is where "the operator is deciding" stops being a plausible description of the run.
 *
 * It is a chosen number, not a measured one, and it is labelled as such for the reason
 * `IDLE_CPU_PERCENT` gives: what must not happen here is a number picked by intuition and then
 * written about as though it were not. What keeps it honest is that reaching it is VISIBLE --
 * the last line says re-measuring has stopped, so a stale reading is never silently stale.
 */
export const LIVENESS_REFRESH_LIMIT = 60

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
  /**
   * When the LAST of the samples above was taken, in epoch milliseconds.
   *
   * Required, and that is the point of #101: a reading with no time on it cannot be discounted
   * by the person reading it, so a pause replayed one for minutes and every reader took it for
   * current. The last sample rather than the first, because the freshest thing the reading
   * knows is what a reader is deciding against.
   */
  measuredAt: number
}

/**
 * Whether the reading beside it is still being re-measured, and how often it has been.
 *
 * Absent where nothing is refreshing -- the `/continue` guard samples once, on demand, and has
 * no loop behind it -- and that absence is reported as silence rather than as `0 refreshes`,
 * which would claim a refresher exists and has done nothing.
 */
export interface LivenessRefreshState {
  /** Re-measurements since the pause was raised. The first reading is not one. */
  count: number
  /**
   * Why no further measurement will be taken, once that is true.
   *
   * Rendered into the line, because a refresher that goes quiet at its limit and says nothing
   * leaves the reader with exactly the silently-ageing number #101 is about.
   */
  final?: string | undefined
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
  return {
    pid,
    alive,
    samples,
    idle: alive && samples.every((c) => c < IDLE_CPU_PERCENT),
    // After the loop, not before it: the reading is as old as its LAST sample, and stamping it
    // at entry would date a `{samples: 3, everyMs: 400}` reading almost a second early.
    measuredAt: Date.now(),
  }
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
 *
 * ## The provenance sentence, and why it is a SEPARATE sentence
 *
 * Everything #101 adds is appended after the reading rather than woven into it: when the
 * measurement was taken, and whether it is still being taken. Kept apart because the two halves
 * answer different questions -- the reading says what the child is doing, the tail says how much
 * that is worth right now -- and because `reportsChildOnCpu` matches the head, so a fact bolted
 * into the `(cpu ...)` clause would put the pause menu's `wait` option one edit away from
 * disappearing.
 */
export function describeLiveness(
  l: ChildLiveness,
  emittedSinceSend: number | undefined,
  refresh?: LivenessRefreshState,
): string {
  if (!l.alive) {
    return `child pid ${l.pid} is gone; the CLI exited without a terminal signal${provenance(l, refresh)}`
  }
  const cpu = l.samples.map((c) => `${c.toFixed(1)}%`).join(', ')
  const since =
    emittedSinceSend === undefined
      ? 'no output count was taken with this reading'
      : emittedSinceSend === 0
        ? 'nothing at all since the prompt was sent'
        : `${emittedSinceSend} event(s) since the prompt was sent`
  const head = (phrase: string): string => `child pid ${l.pid} ${phrase} (cpu ${cpu}) — ${since}. `
  const reading = readingOf(l)
  const tail = provenance(l, refresh)
  if (reading === 'not_computing') {
    return (
      head(PHRASE.not_computing) +
      `Idle is not dead: a CLI waiting on a provider that stopped answering looks like this${tail}`
    )
  }
  if (reading === 'working') {
    return head(PHRASE.working) + `Continuing sends into a live turn, which neither CLI accepts${tail}`
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
    `CLI accepts mid-turn${tail}`
  )
}

/** Seconds, no milliseconds: `ps` resolution does not justify three more digits. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * When this was measured, and whether it is still being measured.
 *
 * Always says WHEN. That half is unconditional on purpose: the `/continue` guard has no
 * refresher behind it and its reading is one second old, but a reading whose age is obvious to
 * the code that made it is exactly the one whose age a later reader cannot see -- and the
 * refusal is written onto the pause (`refusal.reason`) where it is read long afterwards.
 *
 * Says whether it is STILL being measured only when something is doing so. Absent means "one
 * reading, taken on demand", which is a different fact from "a refresher that has run zero
 * times", and reporting the second where the first is true would promise updates nothing is
 * going to deliver.
 */
function provenance(l: ChildLiveness, refresh: LivenessRefreshState | undefined): string {
  const at = `. Measured ${stamp(l.measuredAt)}`
  if (!refresh) return `${at}.`
  if (refresh.final !== undefined) {
    return (
      `${at}, re-measured ${refresh.count} time(s) since the pause was raised, and ` +
      `${refresh.final} — so this reading no longer updates and only ages from here.`
    )
  }
  if (refresh.count === 0) return `${at}, and re-measured while the pause lasts.`
  return `${at}, re-measured ${refresh.count} time(s) since the pause was raised.`
}
