/**
 * A running session, as something outside the process can read.
 *
 * Conclave's console is a rendering with no interface underneath it. An agent driving a run
 * — which is most of them now — launched into a background file, read it with `tail`,
 * grepped a transcript to reconstruct what a participant had done, and watched a rising
 * clock to guess whether the session was still alive. One of those nearly produced a filed
 * bug, because a retry could not be told from a double start. See #26: the workarounds are
 * the requirement.
 *
 * ## Files, not a socket
 *
 * Status is a file the run rewrites, not an endpoint the run answers. The reasoning is the
 * same one `resume.ts` gives for recording continuously: **a record that exists only inside
 * a live process is exactly the record a crash destroys**, and "did it crash" is the first
 * question status has to answer. A socket that stops responding cannot distinguish a dead
 * run from a busy one; a file plus a pid can.
 *
 * It also costs nothing to inspect. `cat .conclave/sessions/<id>/status.json` works from any
 * language, over ssh, and after the process is gone — which is when an operator most wants
 * it.
 *
 * ## Liveness is never read from the file
 *
 * A status saying `running` proves only that the process was running when it last wrote.
 * Every read reconciles the claim against the pid, and the two are reported SEPARATELY —
 * `state` is what the session last said, `alive` is whether anyone is still there. Collapsing
 * them would invent the very reading the issue describes: a session that looks busy because
 * nothing has updated it, which is indistinguishable from one that is busy.
 *
 * `sessionLock` already draws this distinction for the workspace guard, and for the same
 * reason: a crash-proof mechanism that misreports after a crash gets abandoned in a day.
 *
 * ## Two files per session
 *
 *   status.json    the current state, rewritten on every change. Small, whole, atomic.
 *   events.ndjson  the observation stream, appended. Every routing message and every
 *                  adapter event, in the order the relay saw them.
 *
 * The split is between a question with one answer now ("what is it doing") and a question
 * whose answer is the whole history ("what did it do"). Serving both from one file would
 * mean either rewriting the history on every change or scanning it to answer the first.
 */

import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Confidence, Provenance } from '../contract/outcome.ts'
import type { RelayEvent } from '../relay/observe.ts'
import type { RunOutcome, RunPause } from '../relay/run.ts'

/** Bumped when a consumer would break. Present from the first version, as in `report.ts`. */
export const SESSION_SCHEMA = 1

export const SESSIONS_RELATIVE = '.conclave/sessions'

/**
 * What the session last said about itself.
 *
 * Named `SessionRunState` rather than `SessionState`, which the adapter contract already
 * uses for something else entirely -- a participant's lifecycle. Two types with one name in
 * one codebase is a mistake waiting for whoever imports the wrong one.
 *
 * `starting` is a real state and not a nicety: participants are spawned before the first
 * turn, launching a CLI takes seconds, and a status that appeared only once a run was
 * underway would leave the exact window an agent operator polls into.
 */
export type SessionRunState = 'starting' | 'running' | 'paused' | 'ended'

/**
 * One turn as the status file reports it: the verdict AND how strongly it is evidenced.
 *
 * The same four fields `report.ts` puts in `ReportedTurn`, deliberately named and typed the
 * same way. A run report and a status file that disagreed about what a turn was would give
 * an operator two answers and no way to tell which was wrong -- and the two are read by the
 * same kind of consumer, often minutes apart.
 *
 * The tools and timings `ReportedTurn` also carries are left out. A status file is polled,
 * sometimes every second, and it is rewritten whole on every change; the per-turn tool list
 * is the part that grows without bound. It is in the report, and the arguments are in the
 * events stream.
 */
export interface SessionTurnStatus {
  /** Opaque; the adapter's own key. Never parse it. */
  key: string
  state: string
  confidence?: Confidence | undefined
  /** Ordered, most decisive first. The reason a verdict is believed, not just the verdict. */
  provenance?: Provenance[] | undefined
}

/**
 * Where one implementer seat's work IS: which task, which tree, which branch, and what the
 * scheduler thinks of it.
 *
 * Only meaningful once a run has more than one seat, and only emitted then -- see the note on
 * `SessionParticipantStatus.seat`. Every field is projected from what the relay already holds
 * (`seats()`, `tasks()`, `worktrees`); nothing here is a second copy of state the dispatcher
 * would have to keep in step.
 *
 * The four together are what a poller cannot reconstruct from anything else in this file. `id`
 * says which seat, and at N>1 that is where the resemblance to a default run ends: the seats
 * hold different tasks, on different branches, in different checkouts, and an operator or an
 * agent asking "what is seat-beta doing" has no other place to read the answer. `activity`
 * beside it is the last adapter event -- what the child is doing this second -- which is a
 * different question from what it was ASKED to do.
 */
export interface SessionSeatStatus {
  /**
   * The dispatcher's scheduler state: idle, queued, running, integrating, rotation_pending
   * or merge_blocked.
   *
   * A string rather than the `SchedulerState` union, like every other state in this file: the
   * record is JSON and a consumer parses strings. Importing the union would also point the
   * dependency the wrong way -- the relay knows nothing about being recorded.
   */
  state: string
  /** Tasks dispatched to this seat so far. Diagnostic; the events stream is the record. */
  dispatched: number
  /**
   * The task in flight, or absent when the seat is holding none.
   *
   * Absent rather than null for the reason the file gives about `pause`: JSON cannot spell
   * undefined, and a consumer's `if (seat.task)` must mean "there is one".
   */
  task?: { id: string; state: string; instruction: string } | undefined
  /**
   * The linked worktree this seat works in, and the branch its commits land on.
   *
   * Absent when the seat has no worktree of its own. That is every seat of a run started
   * without them, and it is the honest answer rather than a repetition of `cwd`: a seat
   * sharing the operator's checkout has no branch that is ITS branch, and reporting one
   * would tell a recovering operator to look somewhere nothing was written.
   */
  worktree?: { path: string; branch: string } | undefined
}

export interface SessionParticipantStatus {
  id: string
  agent: string
  rank: string
  /**
   * What this seat is for, as opposed to what it can overrule.
   *
   * A poller deciding where to look — which seat is building the api — cannot get that from
   * `rank`, which is the authority ordering and is identical across seats doing different
   * jobs. Present and equal to `implementer` at N=1 rather than omitted, for the reason given
   * about `turns` below: a field that disappears when it agrees with the default forces a
   * reader to tell "no role" apart from "this build does not report roles".
   */
  role: string
  /**
   * How this seat was launched: the whole argv, and the model that argv names.
   *
   * Present at every N and on every seat, unlike `seat` below, because it says something at
   * every N: `agent: opencode` is any of dozens of models at a ~30x price spread (#71), so a
   * poller reading a one-seat run cannot tell an expensive run from a cheap one, nor repeat
   * either. `model` is `null` when the argv named none -- a fact about the run, and
   * deliberately not an empty string.
   *
   * Structural, like every other type in this file: the relay knows nothing about being
   * recorded, and importing `ParticipantLaunch` would point the dependency the wrong way.
   *
   * There is no token count and no cost here, and there is not going to be one. Conclave
   * drives the operator's own CLI on the operator's own subscription; what it can honestly
   * offer is the join key for the billing export their provider already holds.
   */
  launch: { args: string[]; model: string | null }
  /**
   * This seat's turns, from `snapshot()` -- the canonical side of the adapter seam.
   *
   * Required and empty rather than absent before anything has run, for the reason
   * `report.ts` gives about `flags`: a field that vanishes when it has nothing to say
   * forces a reader to distinguish "no turns yet" from "this build does not report turns",
   * and only one of those is a fact about the run.
   *
   * This is the one part of the participant block that is NOT provisional. `activity`
   * below is the last adapter event and is revisable; these are graded verdicts, and an
   * operator confirming a finished run reads them rather than the prose.
   */
  turns: SessionTurnStatus[]
  /**
   * What this seat is doing, from its most recent adapter event.
   *
   * PROVISIONAL, in the seam's own sense: adapter events are the revisable side, and
   * `snapshot()` is canonical. That is the right trade here — a status file answers "what
   * is happening now", and the canonical answer is not available until the turn is over.
   * The `events.ndjson` stream carries the same events for a reader that wants to judge
   * them, and the run report at the end carries the graded verdicts.
   */
  activity?: { kind: string; tool?: string | undefined; since: number } | undefined
  /** Stopped at a permission prompt, and for what. Read from `relay.permissionsPending()`. */
  awaitingPermission?: { tool: string } | undefined
  /**
   * This seat's place in the dispatcher, at N>1 only.
   *
   * ABSENT on every participant of a default run, and that omission is the point rather than
   * an oversight. D1: the default run must not change, and a key appearing on the one
   * implementer of a one-seat run is a key every existing consumer of `status --json` would
   * start seeing. The rest of this file argues the opposite way about fields that vanish when
   * they agree with a default -- `role` and `turns` are present and empty for exactly that
   * reason -- and the two rules genuinely conflict here. D1 wins because this field has
   * nothing to say at N=1: with one seat there is no task to tell from another seat's, no
   * branch that is not the operator's own, and a scheduler state whose only reader is the
   * dispatcher that wrote it.
   *
   * Present on the ADVISOR of no run at any N: the advisor holds no seat, takes no task and
   * has no worktree, and inventing an idle block for it would report a queue position it can
   * never occupy.
   *
   * Emitted from the moment the dispatcher knows its seats, which is when the run starts --
   * so a two-seat session polled while it is still `starting` carries no seat blocks yet, the
   * same way it carries no `activity` yet. A field that is not there because the fact does not
   * exist yet is the honest report of a run that has not begun.
   */
  seat?: SessionSeatStatus | undefined
}

export interface SessionStatus {
  schema: number
  id: string
  /** The orchestrator process. What `alive` is decided from; never trusted from the file. */
  pid: number
  cwd: string
  goal: string
  /** Which front-end opened it. A detached run and a console are not the same thing to drive. */
  front: 'relay' | 'session'
  operator: 'human' | 'agent'
  state: SessionRunState
  startedAt: number
  updatedAt: number
  /** Entries in the routing log. The same count the console prints at the end. */
  messages: number
  participants: SessionParticipantStatus[]
  /**
   * The current pause, verbatim from the handle.
   *
   * The whole pause rather than its reason: a caller deciding whether to intervene needs
   * the evidence and the options, and an agent operator has no console to read them from.
   */
  pause?: RunPause | undefined
  outcome?: RunOutcome | undefined
  /** Where the streams are, so a reader never has to reconstruct a path. */
  eventsPath: string
  /** The resumable routing log, when one is being written. */
  logPath?: string | undefined
  /**
   * The build string that produced this session.
   *
   * `conclave version` reports the package version and, in a checkout, the commit. A status
   * file read after the fact must be able to say which build wrote it, and recomputing at
   * read time would borrow whatever git state exists then -- which in a release archive is
   * none. Captured at startup and recorded once.
   */
  build: string
}

/** A status plus what could only be learned from outside it. */
export interface ReadSession {
  status: SessionStatus
  /**
   * Whether the orchestrator process still exists.
   *
   * Not folded into `state`. A reader wants both: `state: 'running', alive: false` is a
   * crashed run and says so, where a single field would have to choose which lie to tell.
   */
  alive: boolean
  /**
   * Claimed to be going, and nobody is home. The condition that made a retry
   * indistinguishable from a double start.
   */
  abandoned: boolean
}

export function sessionsDir(repoRoot: string): string {
  return join(repoRoot, SESSIONS_RELATIVE)
}

export function sessionDir(repoRoot: string, id: string): string {
  return join(sessionsDir(repoRoot), id)
}

/**
 * A readable, chronological, collision-free id.
 *
 * Not a pid: pids are reused, and an id that can refer to two different sessions is worse
 * than a long one. Not random: an operator has to type it, and a directory listing sorted
 * by name should be sorted by time. The pid suffix separates two sessions started in the
 * same second, which two shells in two worktrees do.
 */
export function newSessionId(now: number, pid: number): string {
  const d = new Date(now)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${stamp}-${pid}`
}

function alive(pid: number): boolean {
  try {
    // Signal 0 tests for existence and permission without delivering anything.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Writes both files for one session.
 *
 * Every failure is swallowed after the first report, exactly as `RunLogWriter` does: a run
 * must not die because its own status could not be written. Losing observability is bad and
 * losing the work is worse.
 */
export class SessionRecorder {
  readonly id: string
  readonly dir: string
  readonly statusPath: string
  readonly eventsPath: string
  #status: SessionStatus
  #failed = false

  constructor(repoRoot: string, status: Omit<SessionStatus, 'schema' | 'eventsPath' | 'updatedAt'>) {
    this.id = status.id
    this.dir = sessionDir(repoRoot, status.id)
    this.statusPath = join(this.dir, 'status.json')
    this.eventsPath = join(this.dir, 'events.ndjson')
    this.#status = {
      ...status,
      schema: SESSION_SCHEMA,
      eventsPath: this.eventsPath,
      updatedAt: status.startedAt,
    }
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch {
      this.#failed = true
    }
    this.write()
  }

  get status(): SessionStatus {
    return this.#status
  }

  /** Merge a change and rewrite. Fields not named keep their current value. */
  update(patch: Partial<Omit<SessionStatus, 'schema' | 'id' | 'eventsPath'>>): void {
    this.#status = { ...this.#status, ...patch, updatedAt: Date.now() }
    this.write()
  }

  /**
   * Rewrite via a temporary file and a rename.
   *
   * A reader polling this file would otherwise eventually catch a partial write and get a
   * JSON parse error it can do nothing about — and the caller most likely to be polling is
   * an agent, which will report the crash rather than retry. `rename` within a directory is
   * atomic on every platform this runs on.
   */
  private write(): void {
    if (this.#failed) return
    const tmp = `${this.statusPath}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify(this.#status, null, 2)}\n`)
      renameSync(tmp, this.statusPath)
    } catch (err) {
      this.#failed = true
      console.error(
        `conclave: could not write session status at ${this.statusPath} ` +
          `(${err instanceof Error ? err.message : String(err)}); ` +
          `\`conclave status\` will not see this run`,
      )
    }
  }

  /** Append one observation event. One JSON object per line, in relay order. */
  event(e: RelayEvent): void {
    if (this.#failed) return
    try {
      appendFileSync(this.eventsPath, `${JSON.stringify(e)}\n`)
    } catch {
      // Deliberately quieter than the status failure above: the status IS the interface,
      // and a stream that stops is visible in the stream itself.
      this.#failed = true
    }
  }
}

/** Read one session, reconciling what it claims against whether it is there. */
export function readSession(repoRoot: string, id: string): ReadSession | undefined {
  const p = join(sessionDir(repoRoot, id), 'status.json')
  if (!existsSync(p)) return undefined
  let status: SessionStatus
  try {
    status = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    // A status caught mid-write is the one case, and `write()` renames to make it
    // impossible. Treated as absent rather than thrown: a corrupt record for one session
    // must not take down a listing of all of them.
    return undefined
  }
  const running = status.state !== 'ended'
  const there = alive(status.pid)
  return { status, alive: there, abandoned: running && !there }
}

/**
 * Every readable record, paired with the directory it was read from.
 *
 * The pairing is kept because the two are not the same fact: the id inside a status file is
 * whatever the file says, and the directory NAME is the only thing that locates the record on
 * disk. Every record conclave writes agrees on both, but a caller that deletes reads the name
 * and a caller that reports reads the id, and quietly using one for the other is how the
 * wrong directory gets removed.
 */
function scanSessions(repoRoot: string): { name: string; session: ReadSession }[] {
  const dir = sessionsDir(repoRoot)
  if (!existsSync(dir)) return []
  const out: { name: string; session: ReadSession }[] = []
  for (const name of readdirSync(dir)) {
    const found = readSession(repoRoot, name)
    if (found) out.push({ name, session: found })
  }
  return out.sort((a, b) => b.session.status.startedAt - a.session.status.startedAt)
}

/** Every session this project has a record of, newest first. */
export function listSessions(repoRoot: string): ReadSession[] {
  return scanSessions(repoRoot).map((s) => s.session)
}

/**
 * Turn what the operator typed into one session.
 *
 * Nothing typed means the most recent, which is what an operator driving one run at a time
 * always means. A prefix is accepted because the ids are timestamps and nobody should have
 * to type twenty characters to ask what their session is doing — but an AMBIGUOUS prefix is
 * refused rather than resolved to the newest match, since picking one silently is how a
 * status command ends up describing the wrong run.
 */
export function resolveSession(
  repoRoot: string,
  id?: string,
): { session: ReadSession } | { error: string } {
  const all = listSessions(repoRoot)
  if (all.length === 0) return { error: 'no sessions have been recorded in this project' }
  if (!id) return { session: all[0]! }
  const exact = all.find((s) => s.status.id === id)
  if (exact) return { session: exact }
  const matches = all.filter((s) => s.status.id.startsWith(id))
  if (matches.length === 1) return { session: matches[0]! }
  if (matches.length > 1) {
    return {
      error:
        `"${id}" matches ${matches.length} sessions: ` +
        `${matches.map((s) => s.status.id).join(', ')}`,
    }
  }
  return { error: `no session "${id}" in this project` }
}

/**
 * The sessions old enough to delete, chosen but not yet touched.
 *
 * Three conditions, all of them required, and the reason is the same one the module opens
 * with: `state` is what the session SAID and `alive` is whether anyone is still there, so
 * neither alone is grounds for deleting anything. A record saying `ended` whose pid is still
 * running is a run that reported its finish and has not exited; a live process whose files
 * vanish underneath it loses the only account of itself that survives a crash.
 *
 * An ABANDONED session -- `running` and nobody home -- is deliberately not a candidate,
 * however old. That is the exact condition #26 was filed about, and it is the one an operator
 * comes looking for days later to find out what happened. Sweeping it up would delete the
 * evidence and leave the tidy runs behind.
 *
 * Directories with no readable `status.json` are also left alone. `readSession` cannot say
 * whether one belongs to a run that is still starting, and the CLI already treats "started
 * but never recorded its state" as its own condition rather than as absence.
 */
export function prunableSessions(repoRoot: string, olderThan: number): ReadSession[] {
  return scanSessions(repoRoot)
    .map((s) => s.session)
    .filter((s) => prunable(s, olderThan))
}

function prunable(s: ReadSession, olderThan: number): boolean {
  return s.status.state === 'ended' && !s.alive && s.status.updatedAt < olderThan
}

/** What a prune chose, and what it managed to do about it. */
export interface SessionPruning {
  /**
   * Every id that met the conditions, whatever then became of it.
   *
   * The sum of the three lists below, and reported separately from all of them so a partial
   * result reads as a partial result rather than as a shorter candidate list than there
   * really was.
   */
  candidates: string[]
  removed: string[]
  /**
   * A candidate that stopped qualifying between the scan and its own removal.
   *
   * Not a failure -- the prune did the right thing -- but not silence either: an operator
   * told "3 candidates" and shown two removals is owed the third line.
   */
  skipped: { id: string; reason: string }[]
  /** One entry per candidate whose directory would not go. The rest are still removed. */
  failed: { id: string; error: string }[]
}

/**
 * Delete the records `prunableSessions` chose.
 *
 * `announce` is called ONCE with the whole candidate list before the first directory is
 * touched, and it is the only way to make good on "here is what I am about to delete". The
 * returned `candidates` cannot do it: by the time a synchronous return is in the caller's
 * hands every removal has already happened, so a CLI printing from it would be describing
 * the past in the future tense -- and if the process died mid-prune the operator would have
 * been shown nothing at all about the records that did go.
 *
 * Re-reading the candidate list instead would not work either, because the two scans need
 * not agree: a session can end, or a pid can exit, between them.
 *
 * Every candidate is re-read through `readSession` immediately before its own removal, and
 * one that no longer qualifies is spared. The scan and the delete are separated by an
 * announcement, an operator reading it, and however long the earlier removals took -- and a
 * pid that came back in that window belongs to a process whose only durable account of
 * itself is the directory about to be deleted. The check is cheap and the loss is not
 * recoverable.
 *
 * Every path removed is rebuilt from an id via `sessionDir` and then checked to be inside the
 * sessions directory, rather than trusted. The ids come from a directory listing today, but
 * this function's whole job is recursive deletion, and a containment check costs nothing
 * against the one mistake here that cannot be undone.
 */
export function pruneSessions(
  repoRoot: string,
  olderThan: number,
  opts?: { announce?: (candidates: readonly string[]) => void },
): SessionPruning {
  const root = resolve(sessionsDir(repoRoot))
  // The directory name, not the id each file claims. They agree in every record conclave
  // writes; where they do not, the name is the one that says what is being deleted.
  const candidates = scanSessions(repoRoot)
    .filter((s) => prunable(s.session, olderThan))
    .map((s) => s.name)
  const out: SessionPruning = { candidates, removed: [], skipped: [], failed: [] }

  // Before the loop, deliberately. Everything after this line is destructive.
  opts?.announce?.(candidates)

  for (const id of candidates) {
    const dir = resolve(sessionDir(repoRoot, id))
    if (dir === root || !dir.startsWith(root + sep)) {
      out.failed.push({ id, error: `${dir} is not inside ${root}` })
      continue
    }
    const now = readSession(repoRoot, id)
    if (!now) {
      // Gone or unreadable since the scan. Nothing here is worth deleting a directory over
      // that we can no longer confirm the contents of.
      out.skipped.push({ id, reason: 'its record could no longer be read' })
      continue
    }
    if (!prunable(now, olderThan)) {
      out.skipped.push({
        id,
        reason: now.alive ? 'its process is alive' : 'it no longer meets the conditions',
      })
      continue
    }
    try {
      // `force` so a record another prune already removed is not an error: two operators
      // tidying the same project should not produce a failure report between them.
      rmSync(dir, { recursive: true, force: true })
      out.removed.push(id)
    } catch (err) {
      // One unremovable directory must not abandon the rest. A prune that stopped at the
      // first permission error would leave the operator to run it again and hit the same one.
      out.failed.push({ id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

/**
 * The repository root, for locating `.conclave/`.
 *
 * A session started in a subdirectory must be findable from the top and vice versa, or the
 * id an operator was handed stops working when they change directory. Falls back to the
 * directory given, so this works outside a repository too.
 */
export function projectRootFor(dir: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out || dir
  } catch {
    return dir
  }
}

/**
 * What recording needs from a relay.
 *
 * Structural rather than importing `Relay`, so a test can drive this with a stand-in and so
 * the dependency runs one way: the relay knows nothing about being recorded.
 */
export interface RecordableRelay {
  readonly cwd: string
  readonly operator: 'human' | 'agent'
  readonly participants: readonly {
    id: string
    rank: string
    role: string
    /**
     * The argv this seat was launched with and the model it names, composed once by the
     * relay at join. Required rather than optional: a stand-in that omitted it would produce
     * a status document missing a key the real one has, which is the drift this contract is
     * structural in order to catch.
     */
    launch: { args: readonly string[]; model: string | null }
    session: {
      readonly agent: string
      /**
       * Just enough of `SessionSnapshot` to grade the turns, structurally. An adapter
       * satisfies this by satisfying `AgentSession`; a test satisfies it with an object
       * literal, which is the point of not importing the interface.
       */
      snapshot(): Promise<{
        turns: readonly {
          key: string
          state: string
          confidence?: Confidence | undefined
          provenance?: Provenance[] | undefined
        }[]
      }>
    }
  }[]
  readonly log: readonly unknown[]
  permissionsPending(): { id: string; tool: string }[]
  observe(opts?: { replay?: boolean }): AsyncIterable<RelayEvent>
  /**
   * The dispatcher's per-seat state, the queue, and the seat worktrees -- the three reads the
   * seat block is projected from.
   *
   * OPTIONAL, all three, and structural like everything else here. A `Relay` satisfies them by
   * having them; a stand-in written before they existed satisfies them by omission, and gets
   * the document it got before -- which is what makes this additive to the recorder's contract
   * rather than a break in it. `Relay` populates `seats()` when a run STARTS, so all three are
   * empty on a session that has not run yet, and the projection says nothing rather than
   * guessing.
   */
  seats?(): readonly { seat: string; state: string; current?: string | undefined; dispatched: number }[]
  tasks?(): readonly { task: { id: string; instruction: string }; runtime: { state: string } }[]
  readonly worktrees?: { seats: readonly { seatId: string; worktreePath: string; branch: string }[] } | undefined
}

/** Live recording, and the handle the front-end uses to report state changes. */
export interface SessionRecording {
  readonly id: string
  readonly recorder: SessionRecorder
  /** Report a lifecycle change. Participants and counters are refreshed on every call. */
  set(state: SessionRunState, extra?: { pause?: RunPause | undefined; outcome?: RunOutcome | undefined }): void
  /**
   * Re-read every participant's snapshot and rewrite the status.
   *
   * Exposed because the caller sometimes knows something the event stream does not -- and
   * because a test asserting on graded turns should be able to say WHEN they were read
   * rather than sleep and hope. `close()` awaits one of these last.
   */
  refresh(): Promise<void>
  /** Stop following the stream. The files stay; only the subscription ends. */
  close(): Promise<void>
}

/**
 * Record a relay to disk for the lifetime of the process.
 *
 * Wired here rather than in either front-end, because "a capability wired into one
 * front-end and not the other" is the mistake this codebase has now made six times. Both
 * `relay` and `session` call this, and neither owns the format.
 *
 * The stream is followed in a detached loop that is deliberately NOT awaited: a recorder
 * that had to be pumped by the run loop would make recording a step in the critical path,
 * and a slow disk would then slow the session down rather than merely lag the file.
 */
export function recordSession(
  relay: RecordableRelay,
  opts: {
    repoRoot: string
    id: string
    goal: string
    front: 'relay' | 'session'
    startedAt: number
    logPath?: string | undefined
    build: string
  },
): SessionRecording {
  /** The last adapter event per seat, which is what "what is it doing" means live. */
  const activity = new Map<string, { kind: string; tool?: string | undefined; since: number }>()
  /**
   * The last snapshot's turns per seat.
   *
   * Cached rather than read at write time because `seats()` is synchronous and `snapshot()`
   * is not -- and it is not for a real reason: it rebuilds from the transcript on disk. A
   * status file that awaited one on every event would make recording a slow step on a path
   * that is deliberately detached from the run.
   */
  const turns = new Map<string, SessionTurnStatus[]>()

  const seats = (): SessionParticipantStatus[] => {
    // Read ONCE per document rather than once per participant: `seats()` and `tasks()` both
    // deep-copy what they return, so a call inside the map would clone the whole queue N
    // times to answer N questions about it.
    const execs = relay.seats?.() ?? []
    // The gate, and the only one: more than one seat in the dispatcher. Not "the run has
    // worktrees" (a seat can share a checkout), not "the participant list has two
    // implementers" (that is true before the dispatcher has any state to report), and not a
    // flag the front-end passes down (a recorder that had to be TOLD the shape of the run
    // would be a second place the seat count is decided).
    const multi = execs.length > 1
    const queue = multi ? (relay.tasks?.() ?? []) : []
    return relay.participants.map((p) => {
      const pending = relay.permissionsPending().find((x) => x.id === p.id)
      const seen = activity.get(p.id)
      const exec = multi ? execs.find((s) => s.seat === p.id) : undefined
      const current = exec?.current === undefined ? undefined : queue.find((e) => e.task.id === exec.current)
      const tree = exec && relay.worktrees?.seats.find((w) => w.seatId === p.id)
      return {
        id: p.id,
        agent: p.session.agent,
        rank: p.rank,
        role: p.role,
        // Copied, like everything else this function returns: the status document is written
        // repeatedly from a live relay, and handing out its own array would let a later reader
        // of an earlier document see a list that had moved underneath it.
        launch: { args: [...p.launch.args], model: p.launch.model },
        turns: turns.get(p.id) ?? [],
        ...(seen ? { activity: seen } : {}),
        ...(pending ? { awaitingPermission: { tool: pending.tool } } : {}),
        ...(exec
          ? {
              seat: {
                state: exec.state,
                dispatched: exec.dispatched,
                // The instruction WHOLE, not a first line. A truncation in a field named
                // `instruction` is a lie a consumer cannot detect, and there is at most one
                // of these per seat -- the growth this file worries about is per-turn tool
                // lists, which are unbounded, not a task the seat is holding right now.
                ...(current
                  ? { task: { id: current.task.id, state: current.runtime.state, instruction: current.task.instruction } }
                  : {}),
                ...(tree ? { worktree: { path: tree.worktreePath, branch: tree.branch } } : {}),
              },
            }
          : {}),
      }
    })
  }

  const recorder = new SessionRecorder(opts.repoRoot, {
    id: opts.id,
    pid: process.pid,
    cwd: relay.cwd,
    goal: opts.goal,
    front: opts.front,
    operator: relay.operator,
    state: 'starting',
    startedAt: opts.startedAt,
    messages: relay.log.length,
    participants: seats(),
    build: opts.build,
    ...(opts.logPath ? { logPath: opts.logPath } : {}),
  })

  /**
   * The last outcome seen, carried forward.
   *
   * A pause and an outcome are not the same kind of fact. A pause is a state the run is IN,
   * so it has to be clearable -- a resumed run still carrying its last pause would tell a
   * poller to intervene in a decision already made. An outcome is something that HAPPENED,
   * and it does not un-happen because the front-end later reported another state. The
   * console proved this immediately: it reports `ended` on teardown, which erased the very
   * outcome the run had just produced.
   */
  let lastOutcome: RunOutcome | undefined

  /**
   * Which refresh a result belongs to, and which one has already landed.
   *
   * A snapshot is a read of a file that is still being written, so two of them do not
   * necessarily come back in the order they were asked for. Without this counter a slow
   * read of an early transcript could return AFTER a fast read of a later one and overwrite
   * the newer turns with older ones -- and the status file would go backwards while the run
   * went forwards, which is the one thing a polled file must never do.
   */
  let issued = 0
  let applied = 0

  const refreshOnce = async (): Promise<void> => {
    const gen = ++issued
    const fresh: [string, SessionTurnStatus[]][] = []
    for (const p of relay.participants) {
      try {
        const snap = await p.session.snapshot()
        fresh.push([
          p.id,
          snap.turns.map((t) => ({
            key: String(t.key),
            state: t.state,
            confidence: t.confidence,
            provenance: t.provenance,
          })),
        ])
      } catch {
        // A snapshot that cannot be rebuilt right now keeps the last one that could. The
        // final refresh runs AFTER `relay.stop()`, when a session may already be gone, and
        // dropping the turns there would lose them at exactly the moment they matter most.
      }
    }
    if (gen < applied) return
    applied = gen
    for (const [id, ts] of fresh) turns.set(id, ts)
    recorder.update({ messages: relay.log.length, participants: seats() })
  }

  /**
   * Refreshes run one at a time. Two concurrent reads of the same transcript are waste
   * rather than safety, and serialising them means the counter above is a backstop instead
   * of the only thing standing between a poller and a status file that moves backwards.
   */
  let queue: Promise<void> = Promise.resolve()
  const refresh = (): Promise<void> => {
    queue = queue.then(refreshOnce).catch(() => {})
    return queue
  }

  const set: SessionRecording['set'] = (state, extra) => {
    if (extra?.outcome) lastOutcome = extra.outcome
    recorder.update({
      state,
      messages: relay.log.length,
      participants: seats(),
      pause: extra?.pause,
      outcome: lastOutcome,
    })
    // Detached: `set` is called from the run loop and a lifecycle change must not wait on a
    // transcript read. The state above is written immediately; the turns catch up.
    void refresh()
  }

  let stop: (() => void) | undefined
  const following = (async () => {
    const stream = relay.observe({ replay: true })
    const it = stream[Symbol.asyncIterator]()
    stop = () => void it.return?.()
    for (;;) {
      const next = await it.next()
      if (next.done) return
      const e = next.value
      recorder.event(e)
      if (e.type === 'activity') {
        // `turn_end` is left in place deliberately: between turns the interesting fact is
        // how the last one ended, and blanking it would show an idle seat as doing nothing
        // when it has just reported a verdict.
        activity.set(e.participant, {
          kind: e.event.type,
          ...('tool' in e.event ? { tool: e.event.tool } : {}),
          since: e.at,
        })
        // The two events that change a VERDICT, as opposed to what a seat is doing. A turn
        // ending produces the grade; a revision withdraws or replaces one. Snapshotting on
        // every event would re-read the transcript for every tool call the child makes, and
        // snapshotting only at the end would leave a long run with nothing to read until it
        // was over -- which for the runs most worth watching is the whole point.
        if (e.event.type === 'turn_end' || e.event.type === 'revision') void refresh()
      }
      // Every event refreshes the participant block, so a permission prompt appears in the
      // status file at the moment it appears in the stream rather than at the next
      // lifecycle change -- which for a seat stopped at a prompt would be never.
      recorder.update({ messages: relay.log.length, participants: seats() })
    }
  })()

  return {
    id: opts.id,
    recorder,
    set,
    refresh,
    /**
     * Wait for the stream to end on its own, then detach.
     *
     * CALL THIS AFTER `relay.stop()`, never before. `Relay.#end` is what emits the terminal
     * `run_end`, and `stop()` is what calls it -- so a front-end that closed the recorder
     * first detached before the event existed, and the recorded stream simply stopped with
     * no line saying the run had finished. Both front-ends did exactly that, and it was
     * found by reading a recorded file rather than by any test.
     *
     * The race is a backstop for a caller that never stops the relay at all: teardown that
     * hangs is worse than teardown that gives up.
     *
     * Then one last snapshot, AWAITED and taken after the stream is done. Both front-ends
     * report `ended` before closing the recorder, and the last turn of a run is graded at
     * the very end -- so a recorder that detached without re-reading would leave the final
     * verdicts out of the only file anyone can read once the process is gone. Last, rather
     * than first, because the follow loop can still queue refreshes while it drains and the
     * final one has to be the one that wins.
     */
    close: async () => {
      await Promise.race([following, new Promise((r) => setTimeout(r, 2_000).unref())])
      stop?.()
      await following
      await refresh()
    },
  }
}
