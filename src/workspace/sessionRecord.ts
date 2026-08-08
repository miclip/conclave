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
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
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

export interface SessionParticipantStatus {
  id: string
  agent: string
  rank: string
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

/** Every session this project has a record of, newest first. */
export function listSessions(repoRoot: string): ReadSession[] {
  const dir = sessionsDir(repoRoot)
  if (!existsSync(dir)) return []
  const out: ReadSession[] = []
  for (const name of readdirSync(dir)) {
    const found = readSession(repoRoot, name)
    if (found) out.push(found)
  }
  return out.sort((a, b) => b.status.startedAt - a.status.startedAt)
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

  const seats = (): SessionParticipantStatus[] =>
    relay.participants.map((p) => {
      const pending = relay.permissionsPending().find((x) => x.id === p.id)
      const seen = activity.get(p.id)
      return {
        id: p.id,
        agent: p.session.agent,
        rank: p.rank,
        turns: turns.get(p.id) ?? [],
        ...(seen ? { activity: seen } : {}),
        ...(pending ? { awaitingPermission: { tool: pending.tool } } : {}),
      }
    })

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
