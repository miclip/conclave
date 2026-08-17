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
 * offers `wait`, because a burst may be a turn and waiting is the non-destructive option. It no
 * longer REFUSES `/continue`: that sentence stood here until #117 moved the send decision onto
 * the turn itself, and it is repaired rather than deleted because the #124 note below is about
 * what the reading does and does not decide now. What changed in #83 is that the operator is
 * told what was actually measured before they choose, instead of being handed a verdict the
 * numbers do not support.
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
 *
 * ## The right process, which is not one process (#111)
 *
 * Everything above measures the pid the orchestrator spawned. A seat that has shelled out to a
 * build or a test suite shows almost nothing on that pid while a grandchild saturates a core, so
 * the reading was fresh, correctly derived, and about the wrong process -- and it failed in the
 * direction that costs most, because a busy seat reading idle is what #43 exists to prevent. The
 * operator who reported it was running `pgrep -f 'go test|go build|clang|z3 '` by hand at every
 * pause, and said the descendant check was decisive twice where CPU alone was ambiguous.
 *
 * So a sample is now one `ps -Ao pid=,ppid=,%cpu=` snapshot of the WHOLE table, walked into the
 * descendant tree of the pid we were given. Five things come out of each snapshot: the parent's
 * own %cpu, the busiest single descendant, the aggregate over parent and every descendant, how
 * many descendants there were, and how many of them were individually at or above the line.
 *
 * The reading is classified on the first two -- `IDLE_CPU_PERCENT` is a per-PROCESS line, so the
 * question it answers is "is any one process in this tree working", asked of the parent and of
 * the busiest thing under it. The aggregate is reported and never thresholded; see
 * `activitySamples`, which is where that argument is written down and where the case this rule
 * gets wrong is named.
 *
 * Three things were checked rather than assumed, and they are the reason the shape is this one:
 *
 *   - COST. The full table on the machine this was written on is ~500 processes and one snapshot
 *     of it measured 0.01-0.02s, against ~0.03s reported by the operator for a 506-process table.
 *     A reading is 3 snapshots, so ~0.06s; a pause that refreshes to its bound spends 180 of them
 *     over thirty minutes, which is a few seconds of `ps` for an entire held pause. The
 *     per-pid `ps` it replaces was the same call with a narrower filter, so this is not a new
 *     cost so much as an unfiltered one.
 *   - EXISTENCE IS NOT WORK. On the same machine, ten idle `sinesync mcp start` helpers sit as
 *     descendants of long-lived parents at 0.0%. A check for "does this seat have descendants"
 *     -- which is what the `pgrep` workaround approximates -- would call every one of those a
 *     working child. So a descendant counts as WORKING only by its own %cpu, and the count of
 *     descendants that exist is reported separately and never on its own.
 *   - AGGREGATION DILUTES, AND IT IS NOT A THRESHOLD. The widest all-idle tree on a 498-process
 *     table summed 2.4% over 19 descendants, with nothing in it above 3%. That is under the line
 *     and not by much: a tree half again as wide crosses it on process count alone, and the first
 *     shape of this change classified on the sum, so it would have reported `working` on the same
 *     line that says no descendant is computing. A reading cannot contradict itself in the
 *     sentence it prints. So the sum is reported as SCALE and the classification asks the
 *     per-process question the threshold was calibrated for -- see `activitySamples`. Where the
 *     sum crosses the line with nothing under it working, the line says so in those words rather
 *     than leaving an operator to reconcile two numbers.
 *
 * `-Ao` and not the `-axo` the report used. `-A` is POSIX "select all processes" and means the
 * same thing on both platforms CI runs (macOS, Ubuntu). Linux's `-a` means "all except session
 * leaders", and a CLI spawned on a pty is very often a session leader -- so on Ubuntu the one
 * process this file exists to measure is the one `-axo` could omit, and it would be reported as
 * `gone`. On macOS the two are identical; the difference is only visible where it would hurt.
 *
 * And a tooling failure is not a death. If no snapshot can be taken at all -- a platform whose
 * `ps` does not accept this, a sandbox that refuses it -- the sample falls back to the per-pid
 * reading this replaced, rather than reporting a live child as gone on the strength of a `ps`
 * that never ran.
 *
 * ## Widening a thin reading, and why it decides nothing either (#124)
 *
 * #124 reports a `/continue` refused on `cpu 0.1%, 3.6%, 0.8%` by a message that names two
 * weaknesses in its own evidence -- no output count was taken with this reading, and the samples
 * disagree -- and then refuses on exactly that evidence. It asks for the repair that shape
 * invites: a guard that can say "I did not take an output count" can take one, so notice the poor
 * reading, widen the sample, and refuse only if it is still ambiguous afterwards.
 *
 * Two facts stand in front of that, and both are pinned by tests rather than argued here.
 *
 *   - THE REFUSAL IS UNREACHABLE. Since #117 the console's `/continue` guard refuses on
 *     `activeTurn` and samples CPU only AFTER it has decided to refuse, as colour that decides
 *     nothing. The run in the report had a closed turn, so today it resumes -- and nothing is
 *     sampled at all, so there is no thin reading for anything to notice. Held with the report's
 *     own numbers in `src/repl/session.test.ts`.
 *   - WIDENING WOULD NOT HAVE LIFTED IT. The operator's own fifteen seconds read
 *     `0.0 0.0 0.0 0.1 0.0`. Added to the three that were refused on, that is eight samples with
 *     one of them at 3.6%, and `not_computing` is EVERY sample below the line -- so the widened
 *     reading is `mixed`, exactly as the narrow one was, and the widened sentence says `7 below
 *     3% and 1 at or above` instead of `2 and 1`. More evidence, same answer.
 *
 * The only widening that changes the answer is one that DISCARDS the samples already in hand and
 * classifies the fresh ones alone. That is not a wider sample, it is a different one, and it is
 * the #83 asymmetry run backwards: a process BETWEEN bursts of real work reads exactly like a
 * finished one that twitched, and calling the first idle is what cost a run. So a re-reading may
 * age out an old measurement -- which is what `LIVENESS_REFRESH_EVERY_MS` already does, on the
 * clock rather than on a hunch that the last reading was disappointing -- and it may not launder
 * a sample that saw CPU out of the record.
 *
 * What survives of #124's general shape is that a caveat should reach its reader, and here it
 * does: the split and the missing output count are both printed, and the output count is an
 * INPUT to the mixed sentence rather than a clause beside it (see #83 above). What no caveat
 * here does any longer is decide a send, because nothing in this file does.
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
 * already has: `/wait` defaults to fifteen (`src/repl/session.ts:2001`), so the refresh has to
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
  /**
   * CPU percentages, in sample order. Empty when the process was gone throughout.
   *
   * The AGGREGATE over the pid and every descendant of it, since #111 -- how much of the machine
   * this seat is using, which is what every existing consumer of this field was reading it as.
   * REPORTED, NOT THRESHOLDED: `IDLE_CPU_PERCENT` is a per-process line and a sum over a hundred
   * processes crosses it on process count alone. What the reading is classified on is
   * `activitySamples` below. The pid's own share is `selfSamples`.
   */
  samples: number[]
  /**
   * The same snapshots, counting the pid alone.
   *
   * The number the old reading printed. Kept because the two together are the diagnosis -- a
   * quiet parent with a busy tree is a seat that shelled out, and a busy parent with a quiet tree
   * is the seat itself working -- and an operator who is about to go and look at the process
   * table needs to know which.
   */
  selfSamples: number[]
  /**
   * The highest single descendant %cpu in each snapshot. Zero where there were none.
   *
   * The other half of what the reading is classified on, and the reason it is a per-snapshot
   * ARRAY rather than the `workingDescendants` count below: the three-reading taxonomy is
   * per-sample, so a compiler that appears in one snapshot of three has to be able to come out
   * `mixed`, exactly as a parent that twitched once does.
   */
  busiestDescendant: number[]
  /**
   * How many descendants were seen, at most, across the snapshots.
   *
   * The most any one snapshot saw rather than the last, on the same reasoning three samples
   * exist for at all: a build that spawns and reaps compilers between two readings is not a
   * seat with no descendants. Reported, never decisive -- see the module note; ten idle MCP
   * helpers are ten descendants and no work.
   */
  descendants: number
  /**
   * How many of those were individually at or above `IDLE_CPU_PERCENT`, at most.
   *
   * This is the fact the `pgrep` workaround was reaching for, and the one the evidence line
   * leads with when the parent is quiet and this is not zero.
   */
  workingDescendants: number
  /**
   * True when every sample was effectively zero.
   *
   * "Not computing", never "dead" — a process blocked on a socket reads the same way, and
   * that is exactly what a provider that stopped answering looks like from out here.
   *
   * Over `activitySamples` since #111, which is where the change lands: a parent idling in front
   * of a busy grandchild is NOT idle any more, and that is the fix -- a reading that was idle can
   * now be busy. What cannot happen is the reverse, because activity is never below the pid's own
   * %cpu, which is the only thing this used to look at.
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

/** One process, as one snapshot saw it. */
export interface ProcessRow {
  pid: number
  ppid: number
  cpu: number
}

/** What one snapshot says about the tree rooted at a pid. */
export interface TreeSnapshot {
  /** The root's own %cpu. */
  self: number
  /** The root plus every descendant. Reported as scale, never thresholded. */
  tree: number
  /** The highest single descendant, or 0 with no descendants. Half of the classification. */
  busiest: number
  /** How many descendants existed, at any depth. */
  descendants: number
  /** How many of those were individually at or above `IDLE_CPU_PERCENT`. */
  working: number
}

/**
 * Parse `pid ppid %cpu` rows.
 *
 * Rows that do not parse are dropped rather than defaulted, because a row with an invented CPU
 * is worse than a row that is not there: the aggregate would carry a number nobody measured.
 * `ps` is run under `LC_ALL=C` so "0.5" cannot arrive as "0,5" on a differently-configured
 * runner and read as a dropped row on Ubuntu and a real one on macOS.
 */
export function parseProcessTable(out: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length !== 3) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    const cpu = Number(parts[2])
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(cpu)) continue
    rows.push({ pid, ppid, cpu })
  }
  return rows
}

/**
 * Walk the descendants of `pid` and total the tree.
 *
 * Undefined when the pid is not in the table, which is the only thing that means "gone" -- a
 * table that could not be read at all never reaches here.
 *
 * Breadth-first over a children index built once, with a visited set. The visited set is not
 * defensive theatre: `ps` takes its rows at slightly different moments, so a table can contain a
 * reparenting that was not true at any single instant, and a walk with no memory would follow it
 * forever. The cost is one Set on a table of a few hundred rows.
 */
export function treeSnapshotOf(rows: ProcessRow[], pid: number): TreeSnapshot | undefined {
  const byPid = new Map<number, ProcessRow>()
  const children = new Map<number, number[]>()
  for (const row of rows) {
    byPid.set(row.pid, row)
    const kids = children.get(row.ppid)
    if (kids) kids.push(row.pid)
    else children.set(row.ppid, [row.pid])
  }
  const root = byPid.get(pid)
  if (!root) return undefined
  let tree = root.cpu
  let busiest = 0
  let descendants = 0
  let working = 0
  const seen = new Set<number>([pid])
  const queue = [...(children.get(pid) ?? [])]
  while (queue.length > 0) {
    const next = queue.pop()!
    if (seen.has(next)) continue
    seen.add(next)
    const row = byPid.get(next)
    if (!row) continue
    descendants++
    tree += row.cpu
    busiest = Math.max(busiest, row.cpu)
    if (row.cpu >= IDLE_CPU_PERCENT) working++
    queue.push(...(children.get(next) ?? []))
  }
  return {
    self: root.cpu,
    busiest,
    // Floating point, three hundred times: 0.1 + 0.2 in the tree of a real machine leaves the
    // aggregate with a tail of digits that would print as 98.30000000000001 if anything ever
    // printed it unrounded. One decimal is what `ps` gave us in the first place.
    tree: Math.round(tree * 10) / 10,
    descendants,
    working,
  }
}

/**
 * One snapshot of the whole process table, or undefined if `ps` would not give us one.
 *
 * The whole table rather than a filtered one: descendants are not knowable from a pid list you
 * would have to already have. Measured at 0.01-0.02s for ~500 processes, which is the budget
 * this is allowed to spend three times per reading.
 */
function processTable(): ProcessRow[] | undefined {
  try {
    const out = execFileSync('ps', ['-Ao', 'pid=,ppid=,%cpu='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // A machine with a runaway fork bomb is not the machine to throw ENOBUFS on. ~20 bytes a
      // row means this covers a few hundred thousand processes; the default 1MB covers ~50k.
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    })
    const rows = parseProcessTable(out)
    return rows.length > 0 ? rows : undefined
  } catch {
    return undefined
  }
}

/**
 * The pid alone, for when the table could not be read.
 *
 * This is what every reading was before #111. It is kept as the fallback because the failure it
 * covers -- a `ps` that will not enumerate, on some platform or sandbox nobody has tried yet --
 * would otherwise turn into "the CLI exited without a terminal signal", which is a confident
 * claim about a child that is very probably fine.
 */
function selfOnlySnapshot(pid: number): TreeSnapshot | undefined {
  try {
    const out = execFileSync('ps', ['-o', '%cpu=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim()
    if (!out) return undefined
    const n = Number(out.split('\n')[0]?.trim())
    if (!Number.isFinite(n)) return undefined
    return { self: n, tree: n, busiest: 0, descendants: 0, working: 0 }
  } catch {
    // A dead process, or a platform whose `ps` does not speak this either. Both mean "no
    // reading", and neither is worth failing a pause over.
    return undefined
  }
}

/** One reading of the tree, by whichever route works. */
function sampleOnce(pid: number): TreeSnapshot | undefined {
  const rows = processTable()
  // A readable table that does not contain the pid is the one honest "gone": the fallback is
  // for a table that could not be read, not for a process that is not in it.
  if (rows) return treeSnapshotOf(rows, pid)
  return selfOnlySnapshot(pid)
}

/**
 * Sample a child's process tree a few times.
 *
 * Bounded and small: this runs while an operator waits to be told what happened, and a
 * diagnosis that takes longer than the decision it informs is not worth having. Three snapshots
 * of a ~500-process table is ~0.06s, and a pause that refreshes to `LIVENESS_REFRESH_LIMIT`
 * spends 180 of them across half an hour.
 */
export async function sampleLiveness(
  pid: number,
  opts: { samples?: number; everyMs?: number } = {},
): Promise<ChildLiveness> {
  const count = opts.samples ?? 3
  const everyMs = opts.everyMs ?? 400
  const samples: number[] = []
  const selfSamples: number[] = []
  const busiestDescendant: number[] = []
  let descendants = 0
  let workingDescendants = 0
  for (let i = 0; i < count; i++) {
    const snap = sampleOnce(pid)
    if (snap) {
      samples.push(snap.tree)
      selfSamples.push(snap.self)
      busiestDescendant.push(snap.busiest)
      // The most any snapshot saw, not the last. A build that spawns and reaps a compiler
      // between two readings did have a working descendant, and the whole reason there are
      // three readings is that one of them can miss what the others catch.
      descendants = Math.max(descendants, snap.descendants)
      workingDescendants = Math.max(workingDescendants, snap.working)
    }
    if (i < count - 1) await new Promise((r) => setTimeout(r, everyMs))
  }
  const alive = samples.length > 0
  return {
    pid,
    alive,
    samples,
    selfSamples,
    busiestDescendant,
    descendants,
    workingDescendants,
    // Over ACTIVITY, not over the aggregate: `IDLE_CPU_PERCENT` is a per-process line, and a
    // hundred idle helpers summing past it would make a sleeping seat read busy on process
    // count. See `activitySamples`.
    idle: alive && activitySamples({ samples, selfSamples, busiestDescendant }).every((c) => c < IDLE_CPU_PERCENT),
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
 * The busiest single process in the tree, per snapshot. What the reading is classified on.
 *
 * `IDLE_CPU_PERCENT` is a line drawn against ONE process -- an idle Claude Code TUI at ~1%, a
 * working one at 12-17%. Comparing a sum of many processes against it asks a different question
 * with the same number, and the answer scales with how many descendants a seat happens to have:
 * the widest all-idle tree measured on a 498-process table summed 2.4% over 19 descendants, so a
 * tree half again as wide reads `working` while the same line says nothing in it is computing.
 * That is not a conservative failure, it is a self-contradicting one, and it would have been
 * loudest on exactly the long-lived MCP-heavy seats this project runs.
 *
 * So activity is the maximum over the pid and its busiest descendant, which is the same question
 * `IDLE_CPU_PERCENT` was calibrated for, asked of every process in the tree instead of one. The
 * aggregate stays on the record and in the prose as SCALE -- how much machine this seat is using
 * -- where no threshold is applied to it.
 *
 * The cost of that choice, named rather than discovered: genuinely parallel work spread so thin
 * that no single process reaches 3% now reads `not_computing`. Four compilers at 2% each is not
 * a shape anyone has observed -- real build steps saturate -- but it is the case this rule gets
 * wrong, and it gets it wrong in the #43 direction, so it is written here rather than left for
 * someone to find. Nothing else changes: a seat with one busy descendant, which is what #111 was
 * raised about, classifies identically either way.
 */
export function activitySamples(
  l: Pick<ChildLiveness, 'samples' | 'selfSamples' | 'busiestDescendant'>,
): number[] {
  // Indexed against `samples` because that is the array whose length says how many snapshots
  // succeeded; the other two are pushed with it. A reading hand-built without them falls back to
  // the aggregate, which is what it was before there was anything else to fall back to.
  return l.samples.map((tree, i) => Math.max(l.selfSamples[i] ?? tree, l.busiestDescendant[i] ?? 0))
}

/**
 * Which of the three a reading is.
 *
 * Restated from the samples rather than read off `idle`, so the reading cannot contradict the
 * numbers printed beside it. It is the same rule: `not_computing` is every sample below the
 * line, which is exactly what `sampleLiveness` set `idle` on.
 *
 * Over `activitySamples` since #111, so a parent at 0.2% in front of a `go test` at 99% is
 * `working` — the classification is of the seat, not of the one process the orchestrator happens
 * to hold a handle to, and not of a sum whose size depends on how many helpers are asleep.
 */
export function readingOf(l: ChildLiveness): LivenessReading {
  if (!l.alive) return 'gone'
  const activity = activitySamples(l)
  if (activity.every((c) => c < IDLE_CPU_PERCENT)) return 'not_computing'
  if (activity.every((c) => c >= IDLE_CPU_PERCENT)) return 'working'
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

/**
 * The headline when the pid itself is quiet and something under it is not.
 *
 * The sentence #111 asks for in as many words: `child pid 44250 quiet, 1 descendant working`.
 * "child pid N is barely running" was true and misleading in exactly this case, and it is the
 * case an operator was running `pgrep` at every pause to detect.
 *
 * Written as a function because the count is in it, which is what `DESCENDANTS_WORKING` below
 * exists for: a phrase with a variable in it cannot be matched by `includes`, and a matcher
 * written from memory in another file is the coupling this block already lost once.
 */
function descendantsWorkingPhrase(n: number): string {
  return `quiet, ${n} descendant${n === 1 ? '' : 's'} working`
}

/** The same phrase, as a matcher. Pinned against the builder in liveness.test.ts. */
const DESCENDANTS_WORKING = /quiet, \d+ descendants? working \(cpu /

/** The phrases that report a child with something on the CPU, mixed included. */
const ON_CPU = [PHRASE.working, PHRASE.barely, PHRASE.bursts]

/**
 * Whether an evidence line reports a child that had CPU in at least one sample.
 *
 * For callers deciding what to OFFER rather than what to say — the pause menu's `wait`. Reads
 * the line the operator reads, so the option and the reason for it cannot disagree.
 *
 * A quiet parent in front of a working descendant counts, and has to: that reading is the one
 * where waiting is most obviously right, and it is the one whose head does not contain any of
 * the four fixed phrases.
 */
export function reportsChildOnCpu(evidence: string): boolean {
  if (DESCENDANTS_WORKING.test(evidence)) return true
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
  const percents = (xs: number[]): string => xs.map((c) => `${c.toFixed(1)}%`).join(', ')
  // Both halves only where there are two halves. With no descendants the tree IS the pid, and
  // printing `0.3% self; 0.3% tree` would spend a clause on a distinction that does not exist --
  // and would move the head of every line the #83 and #101 work pinned.
  const cpu =
    l.descendants > 0 && l.selfSamples.length > 0
      ? `${percents(l.selfSamples)} self; ${percents(l.samples)} tree`
      : percents(l.samples)
  const since =
    emittedSinceSend === undefined
      ? 'no output count was taken with this reading'
      : emittedSinceSend === 0
        ? 'nothing at all since the prompt was sent'
        : `${emittedSinceSend} event(s) since the prompt was sent`
  const head = (phrase: string): string => `child pid ${l.pid} ${phrase} (cpu ${cpu}) — ${since}. `
  const reading = readingOf(l)
  const tail = provenance(l, refresh)
  // The #111 case: the pid is quiet and something under it is not. It gets the HEAD rather than a
  // sentence further down, because the head is what the operator reads and "is barely running"
  // was a true statement about the wrong process.
  const parentQuiet = l.selfSamples.length > 0 && l.selfSamples.every((c) => c < IDLE_CPU_PERCENT)
  const descendantLed = l.workingDescendants > 0 && parentQuiet
  // Where the descendants are not the headline they are still a fact, and the zero-working case
  // is the one with a falsifier behind it: ten idle MCP helpers are ten descendants and no work,
  // so the line says both numbers rather than the one that sounds like activity.
  const descendantNote =
    descendantLed || l.descendants === 0
      ? ''
      : l.workingDescendants > 0
        ? `${l.workingDescendants} of ${l.descendants} descendant(s) had CPU too. `
        : `${l.descendants} descendant(s) exist and none of them is computing — a descendant is ` +
          `not evidence of work, only a place work could be. `
  // The sum crossing the line while nothing under it is working. Said out loud, because the
  // reader can see both numbers and the line would otherwise look like it had contradicted
  // itself -- and because it is a real fact about the seat: a lot of processes, none of them
  // doing anything, which is what a long-lived CLI with a shelf of MCP helpers looks like.
  const diluted =
    l.samples.some((c) => c >= IDLE_CPU_PERCENT) && activitySamples(l).every((c) => c < IDLE_CPU_PERCENT)
      ? `The tree totals ${Math.max(...l.samples).toFixed(1)}% across ${l.descendants} descendant(s) ` +
        `with no single process at ${IDLE_CPU_PERCENT}% — that is process count, not work, and it ` +
        `is not read as activity. `
      : ''
  if (reading === 'not_computing') {
    // Quiet everywhere in the tree WITH output still arriving. The honest reading of that is not
    // "idle": it is a turn whose work is not happening on this machine, which is exactly what a
    // model generating a long reply looks like from the process table. Saying "alive but not
    // computing" and stopping there invites the operator to treat it as a free seat.
    const generatingElsewhere =
      emittedSinceSend !== undefined && emittedSinceSend > QUIET_EVENT_COUNT
        ? `. Nothing in this tree is computing — not the pid` +
          (l.descendants > 0 ? ` and not one of its ${l.descendants} descendant(s)` : ` and it has no descendants`) +
          ` — yet ${emittedSinceSend} event(s) have arrived since the prompt was sent, so the work ` +
          `is somewhere this reading cannot see it: a turn generating at the provider, not a seat ` +
          `with nothing to do`
        : ''
    return (
      // The note is dropped where the sentence below says the same thing at more length: it
      // names the descendants and what they were not doing, and saying it twice reads as two
      // findings rather than one.
      head(PHRASE.not_computing) +
      diluted +
      (generatingElsewhere || diluted ? '' : descendantNote) +
      `Idle is not dead: a CLI waiting on a provider that stopped answering looks like ` +
      `this${generatingElsewhere}${tail}`
    )
  }
  if (reading === 'working') {
    return (
      head(descendantLed ? descendantsWorkingPhrase(l.workingDescendants) : PHRASE.working) +
      descendantNote +
      `Continuing sends into a live turn, which neither CLI accepts${tail}`
    )
  }
  // Over ACTIVITY, not over the aggregate: this sentence explains the reading, so counting a
  // different set of numbers than `readingOf` did would print a split that does not add up to
  // the phrase in front of it.
  const activity = activitySamples(l)
  const low = activity.filter((c) => c < IDLE_CPU_PERCENT).length
  const high = activity.length - low
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
    head(descendantLed ? descendantsWorkingPhrase(l.workingDescendants) : low > high ? PHRASE.barely : PHRASE.bursts) +
    descendantNote +
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
