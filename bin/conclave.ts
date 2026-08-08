#!/usr/bin/env node
/**
 * Conclave CLI. Currently one subcommand; the shape is here so `config install` does not
 * end up as an ad-hoc script that only its author knows to run.
 */

import {
  AGENT_KINDS,
  formatInstallResult,
  formatInstallResultJson,
  hasDrift,
  installConfig,
  type AgentKind,
} from '../src/config/install.ts'
import {
  CONFIG_RELATIVE,
  CONFIGURABLE_AGENTS,
  launchArgsFor,
  permissionModeFor,
  readProjectConfig,
  setPermissionMode,
} from '../src/config/project.ts'
import { formatConfigShow, formatConfigShowJson, showConfig } from '../src/config/show.ts'
import type { CheckSpec } from '../src/rotation/record.ts'
import type { ProjectConfig } from '../src/config/project.ts'
import { runReport } from '../src/relay/report.ts'
import { RunLogWriter, readRunLog, runLogExists } from '../src/relay/resume.ts'
import { preflightRefusals } from '../src/relay/guardrails.ts'
import { ensureCodexHooksTrusted } from '../src/deployment/ensureTrust.ts'
import type { ReadSession } from '../src/workspace/sessionRecord.ts'
import { execFileSync, spawn } from 'node:child_process'
import {
  listSessions,
  newSessionId,
  pruneSessions,
  readSession,
  sessionDir,
  projectRootFor,
  recordSession,
  resolveSession,
  SessionRecorder,
} from '../src/workspace/sessionRecord.ts'
import {
  formatSession,
  formatSessionJson,
  formatSessionLine,
} from '../src/workspace/sessionView.ts'
import { formatGoalFindings, lintGoal } from '../src/relay/goalLint.ts'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { seedCodexTrust } from '../src/deployment/codexHookTrust.ts'
import { defaultRegistry } from '../src/registry/builtin.ts'
import { runSession } from '../src/repl/session.ts'
import { Relay } from '../src/relay/relay.ts'
import { formatGuardReportJson, guard } from '../src/workspace/sessionLock.ts'

const USAGE = `conclave <command>

Driving conclave from an agent
  Use "session", not "relay". relay returns an outcome, so a pause has nowhere to
  suspend to and every pause point ENDS the run; session holds a pause open as a
  decision point you answer. Both take --operator agent, which tells the advisor a
  machine is answering: escalate about premises and ambiguous criteria, not permission.

  Both register hooks and get Codex to trust them for you -- there is no separate setup
  step. A first run in a fresh project answers Codex's own prompts, verifies what got
  recorded, and writes the entries directly if the prompts did not take. Only if all of
  that fails do you need "config install --trust", which records them with no TUI at all.

  Keep stdin OPEN and write commands as lines. Closing it ends the session once its
  current run finishes.
    /continue /rotate /abort        answer a pause
    /allow /deny                    answer a permission prompt
    /pause /state /log /exit        drive and inspect
    @advisor ... / @implementer ... send a message to one seat
    anything else                   the goal, if none has been given yet

  Observe from another process, without scraping the console:
    conclave status [<id>] --json   what it is doing now: seats, what each is working
                                    on, whether one is stopped at a permission prompt,
                                    the current pause with its evidence and options,
                                    and per-turn verdicts with confidence and provenance
    conclave events [<id>] --follow the same run as NDJSON, including pause and resume,
                                    so you are woken at a decision point rather than
                                    polling. Stops when the session does.
    conclave sessions --json        every run recorded in this project, newest first

  Liveness is never read from the file. "state" is what the session last said and
  "alive" is whether its process exists, reported separately: state "running" with
  alive false is a crashed run, not a busy one. "abandoned" is that pair named.

  A goal is linted before anything starts. Name something that can be run, compared
  or observed -- otherwise the participants cannot know when they are done, and the
  outcome cannot be graded above reasoned_but_unverified however well the work goes.

  Exit codes: status is non-zero only for an abandoned run, because a run that ended
  badly still ended and its outcome is in the record. relay is non-zero on
  transport_failed or a ceiling. guard is non-zero while participants are live.

Commands:
  config install [--claude] [--codex] [--no-diagnose] [--trust]
                                   Register Conclave's hooks in the project you are in,
                                   then report whether Codex will run them. The commands
                                   written point back at this Conclave, so the project
                                   needs nothing installed. Both CLIs are registered
                                   unless you name one: pass --claude alone if both roles
                                   are Claude, and no Codex sidecar is written or trusted.
  config check   [--claude] [--codex] [--no-diagnose] [--json]
                                   Report drift without writing. Exits non-zero if the
                                   registrations differ from the templates. Prefer this
                                   before anything that depends on stable Codex trust.
                                   --json prints the report as JSON on stdout instead of
                                   prose; the exit code is unchanged.
  config show    [--json]          Print what this checkout resolves to: the project root,
                                   the Conclave whose hooks would run, the permission mode
                                   in force for each agent, and where each registration
                                   goes plus what is at that path now — missing, current,
                                   drifted, or unknown when it could not be compared.
                                   Reads only: it writes nothing, creates no directories
                                   and does not diagnose Codex trust, so it is safe to run
                                   at any time, and a broken target is reported rather
                                   than sinking the report. Always exits zero even on
                                   drift; config check is the one to gate on.
  guard          [--json]          Report whether participant sessions are live and which
                                   paths changed since they started. Exits non-zero while
                                   live, so it can gate a commit helper. --json prints the
                                   report as JSON on stdout instead of prose; the exit
                                   code is unchanged.
  relay "<goal>" [--advisor codex] [--implementer claude] [--rounds N] [--settle SECONDS]
                 [--checks "npm test"] [--checks-informational "..."]
                 [--checks-unrelated "..."] [--advisor-args "..."] [--implementer-args "..."]
                 [--salvage SECONDS] [--json] [--resume <log>] [--record <path>] [--dry-run]
                 [--force]
                 [--max-turns N] [--max-minutes N] [--strict-goal] [--operator agent]
                 [--bypass [agent]] [--detach]
                                   Run a two-agent session unattended and print the
                                   routing log. --json prints a structured record of the
                                   run on stdout instead — outcome, per-turn verdicts with
                                   their confidence and provenance, rotation counters,
                                   carried flags — and every human-facing line goes to
                                   stderr, so stdout parses in full.
                                   Every message is recorded to
                                   .conclave/runs/ as it happens; --resume replays that
                                   log into both seats so a run that ended with work in
                                   flight is continued rather than re-described by hand.
                                   --operator agent tells the advisor a machine is
                                   answering: escalate readily, but about premises and
                                   ambiguous criteria rather than permission.
                                   The goal is linted before anything starts: an ask with
                                   nothing observable in it cannot be graded better than
                                   reasoned_but_unverified however well the work goes.
                                   Warnings by default, --strict-goal to refuse.
                                   --bypass writes "permissions": "bypass" into
                                   .conclave/config.json, for this run and future ones.
                                   Name an agent to scope it. The models then run commands
                                   without asking; it is as dangerous as it sounds.
                                   --dry-run resolves everything and starts nothing.
                                   --max-turns / --max-minutes stop a run that is still
                                   going, exit non-zero, and put the intended length into
                                   the record. Refuses to start outside a git repository
                                   unless --force.
                                   --settle bounds how long a turn's transcript is given to
                                   catch up with the hook that says the turn ended. If it
                                   catches up with NOTHING, --salvage (default 90s) is how
                                   much longer the run waits before treating the report as
                                   lost -- because the alternative is ending the run holding
                                   no account of work already on disk.
                                   Every pause point ENDS the run, because a call that
                                   returns an outcome has nowhere to suspend to.
                                   --detach hands the run to a background process and
                                   prints its session id, so the terminal is free. Follow
                                   it with conclave status and conclave events; its
                                   stdout and stderr go to stdio.log beside them, because
                                   a crash before the relay starts appears nowhere else.
                                   Every run is recorded either way -- detaching changes
                                   who waits for it, not what is written down.
                                   Spawns real sessions and uses real quota.
  sessions       [--json]          List every session recorded in this project, newest
                                   first: id, state, how long since it last updated, and
                                   the goal. A run whose process is gone is shown as
                                   abandoned rather than as whatever it last claimed.
                 --prune [--days N]
                                   Delete the records of sessions that ENDED, whose process
                                   is gone, and that last updated more than N days ago —
                                   7 by default, and 0 means every one that qualifies. Live
                                   sessions are never touched however old, and neither is an
                                   abandoned run: that record is the evidence of the crash.
                                   Every id is printed before the first deletion, and again
                                   as an outcome; under --json that announcement is on
                                   stderr so stdout carries the result alone. An argument
                                   this does not recognise is refused rather than ignored.
  status [<id>]  [--json]          What one session is doing: participants, what each is
                                   working on, whether either is stopped at a permission
                                   prompt, the current pause with its evidence and options,
                                   and the outcome once there is one. The id is optional
                                   and means the most recent; a unique prefix is enough.
                                   Exits non-zero only for an abandoned run -- a session
                                   that ended badly ended, and its outcome is in the record.
  events [<id>]  [--follow]        The session's event stream as NDJSON: every routed
                                   message and every adapter event, in relay order.
                                   --follow tails it and stops when the session does.
                                   Includes pause and resume, so a driver is woken at a
                                   decision point rather than polling status for it.
                                   New event types are added over time: ignore any
                                   type you do not recognise rather than treating the
                                   set as closed.
  version                          Print the version of this build.
  demo [--record <file>]           Run the console against scripted participants: real
                                   terminal, real readline, no agents and no quota. For
                                   looking at rendering changes in seconds rather than
                                   minutes. --record tees every byte, escape codes
                                   included, so a rendering fault can be inspected rather
                                   than screenshotted.
  session ["<goal>"] [--advisor codex] [--implementer claude] [--rounds N]
                   [--checks "npm test"] [--checks-informational "..."]
                   [--checks-unrelated "..."] [--advisor-args "..."] [--implementer-args "..."]
                   [--bypass [agent]] [--operator agent] [--settle SECONDS]
                   [--salvage SECONDS] [--record <path>] [--resume <log>] [--force]
                                   The same session, interactively. The goal is optional:
                                   without one the console waits and the first thing you
                                   type starts the run. Pauses become decision
                                   points you resolve: /continue, /rotate, /abort, or a
                                   line of text addressed with @advisor / @implementer.
                                   Shows participant activity while a turn is running.
                                   --advisor-args / --implementer-args pass extra launch
                                   arguments, e.g. "-m opencode/kimi-k2.6". Required for
                                   any agent that picks its model per invocation.
                                   --checks are REQUIRED: a replacement that cannot
                                   reproduce one rolls the rotation back.
                                   --checks-informational and --checks-unrelated run and
                                   are reported, but never block a transfer -- for checks
                                   that do not exercise the transferred work.
                                   --checks enables rotation; without it a degraded
                                   implementer escalates rather than rotating unverified.
                                   --operator agent as in relay. Prefer THIS command for an
                                   agent driver: a pause here is held open as a decision
                                   point, where relay ends the run at every one of them.
                                   Commands arrive on stdin as lines, and conclave status
                                   reports the pause with its evidence and options as data,
                                   so nothing has to be scraped off the console.
                                   Refuses to start outside a git repository unless --force,
                                   as relay does: attribution and rotation both diff the
                                   tree, and so does undo.
                                   Every message is recorded to .conclave/runs/ as it
                                   happens, and --resume replays that log into both seats.
                                   Prefer resuming HERE rather than into relay: a resumed
                                   run that hits a pause is held open for you, where relay
                                   would end again at the first one.
                                   --settle / --salvage as in relay. --record tees every
                                   byte written to the terminal, escape codes included, so
                                   a rendering fault can be inspected rather than
                                   screenshotted.
`

/**
 * The version in the banner, read from package.json.
 *
 * A release ships one archive per platform and they are otherwise indistinguishable, so a
 * session has to be able to say which build produced it. Read rather than compiled in,
 * because there is no build step to compile it in at.
 */
/**
 * What this build actually is, not what its package.json claims.
 *
 * `package.json` is bumped once per release, so a checkout running thirteen commits past a
 * tag reported the tag -- and a symlink on PATH pointing into a working tree is the normal
 * way to run this while developing it. Two projects filed bugs against builds it described
 * as `0.2.7`; one of them supplied the commit by hand because the tool would not.
 *
 * A release archive carries no `.git`, so it gets the plain version and nothing is appended.
 * A checkout gets the commit and a `-dirty` marker, which is the difference between "I know
 * exactly what you ran" and a guess.
 */
function version(): string {
  let base = 'unknown'
  try {
    base = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version
  } catch {
    /* an install missing its manifest is broken in a way this line cannot fix */
  }
  try {
    const root = join(import.meta.dirname, '..')
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    // `--git-dir` rather than `rev-parse HEAD` so a checkout of some OTHER repository that
    // happens to contain this install is not mistaken for conclave's own history.
    if (git(['rev-parse', '--show-toplevel']) !== realpathSync(root)) return base
    const commit = git(['rev-parse', '--short', 'HEAD'])
    const dirty = git(['status', '--porcelain']) === '' ? '' : '-dirty'
    return `${base} (${commit}${dirty})`
  } catch {
    // No git, or not a checkout: a release archive, which is exactly the case where the
    // package version is the whole truth.
    return base
  }
}

/**
 * `--claude` / `--codex` select what to register; naming neither registers both.
 *
 * Returned as a partial option object rather than a default-filled array so that "not
 * specified" stays distinct from "explicitly both" all the way down to `installConfig`,
 * which owns the default.
 */
function agentsFromFlags(flags: string[]): { agents?: AgentKind[] } {
  const named = AGENT_KINDS.filter((a) => flags.includes(`--${a}`))
  return named.length > 0 ? { agents: named } : {}
}

/**
 * Split a `--lead-args` / `--implementer-args` value into argv.
 *
 * Naive whitespace splitting, which is enough for `-m provider/model` and deliberately not
 * a shell parser: anything needing quoting belongs in the library API rather than in a flag.
 *
 * This exists because OpenCode selects its MODEL per invocation. Without a way to pass one
 * from the CLI, an `opencode` participant runs with no model pinned -- which is the failure
 * that cost a day in #23: the process stays alive, emits nothing, and never exits. So this
 * is a precondition for the third agent being usable at all, not a convenience.
 */
function extraArgs(raw: string): string[] {
  return raw.split(/\s+/).map((a) => a.trim()).filter(Boolean)
}

/**
 * Verification commands with their declared relevance.
 *
 * Three flags rather than an inline syntax. A separator inside `--checks` would have to
 * survive commands that already contain colons, equals signs and commas, and getting that
 * wrong turns a required gate into an unrelated one silently. Separate flags also match
 * what the design demands: relevance is DECLARED BY THE ORCHESTRATOR, so it belongs in the
 * orchestrator's own vocabulary rather than smuggled into a command string.
 */
function parseChecks(
  required: string,
  informational: string,
  unrelated: string,
): CheckSpec[] {
  const split = (raw: string) => raw.split(',').map((c) => c.trim()).filter(Boolean)
  return [
    // A bare --checks entry stays `required`, which is what every check was before
    // relevance existed. Downgrading an existing configuration would weaken a gate
    // someone is relying on without saying so.
    ...split(required).map((command): CheckSpec => command),
    ...split(informational).map((command): CheckSpec => ({ command, relevance: 'informational' })),
    ...split(unrelated).map((command): CheckSpec => ({ command, relevance: 'unrelated' })),
  ]
}

/**
 * `--bypass [agent]`: put the project into permissive mode and RECORD it.
 *
 * Written to `.conclave/config.json` rather than applied for one run. An operator asking for
 * this almost never means "just this once"; they mean "stop asking me in this project". A
 * flag that applied only to the current invocation would be retyped every time and end up in
 * a shell alias -- the same persistence with none of the visibility.
 *
 * Which is exactly why it announces itself. `.conclave/` is gitignored, so the change is
 * machine-local and invisible to everyone else, including the same operator tomorrow.
 */
function bypassRequest(args: string[]): { requested: boolean; agent?: string | undefined } {
  const i = args.indexOf('--bypass')
  if (i < 0) return { requested: false }
  const next = args[i + 1]
  const agent =
    next && (CONFIGURABLE_AGENTS as readonly string[]).includes(next) ? next : undefined
  return { requested: true, ...(agent ? { agent } : {}) }
}

/**
 * The in-memory config this run should use, given `--bypass`.
 *
 * Applied separately from being PERSISTED, because the two belong at different points. The
 * run must see its own flag immediately, or `--bypass` would not take effect until the next
 * invocation. The write has to wait until the run is actually going to start, or a dry run
 * and a refused preflight both leave a consequential setting behind.
 */
function withBypass(config: ProjectConfig, req: { requested: boolean; agent?: string | undefined }): ProjectConfig {
  if (!req.requested) return config
  return req.agent
    ? { ...config, agents: { ...(config.agents ?? {}), [req.agent]: { permissions: 'bypass' } } }
    : { ...config, permissions: 'bypass' }
}

function applyBypassFlag(args: string[], say: (line: string) => void): boolean {
  const i = args.indexOf('--bypass')
  if (i < 0) return true
  // An agent name may follow, and it must be a KNOWN agent rather than merely not
  // flag-shaped. Accepting any non-flag token meant `conclave session --bypass "fix the login
  // bug"` wrote `agents["fix the login bug"]` into the config AND silently dropped the goal,
  // because the goal is args[0] and args[0] was `--bypass`.
  const next = args[i + 1]
  const agent =
    next && (CONFIGURABLE_AGENTS as readonly string[]).includes(next) ? next : undefined

  try {
    const { path, previous } = setPermissionMode(process.cwd(), 'bypass', agent)
    const scope = agent ? `${agent}` : 'every agent'
    say(`  permission mode for ${scope} set to BYPASS and written to ${path}`)
    if (previous !== 'bypass') {
      say(`    it now applies to FUTURE runs in this project too — set "permissions": "ask" to undo`)
    }
    return true
  } catch (err) {
    console.error(`conclave: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/**
 * Refuse an argument whose leading dash is not a dash.
 *
 * Em and en dashes reach a command line constantly -- autocorrect, a copied snippet, a chat
 * client being helpful -- and `--bypass` typed as `\u2014-bypass` matches no flag, so it is
 * silently ignored. That direction is the dangerous one: the operator believes permissions
 * are bypassed, the run is unattended, and it stops at the first prompt with nobody to
 * answer it.
 *
 * Refused rather than corrected. Guessing which flag someone meant is how a typo becomes a
 * different command than the one they typed.
 */
const UNICODE_DASHES = /^[\u2010-\u2015\u2212]/

function rejectUnicodeDashes(args: string[]): boolean {
  const bad = args.filter((a) => UNICODE_DASHES.test(a))
  if (bad.length === 0) return true
  for (const a of bad) {
    console.error(
      `conclave: "${a}" starts with an ${a[0] === '\u2014' ? 'em dash' : 'en dash'}, not "--". ` +
        `It matches no flag and would be ignored silently. Did you mean "--${a.replace(UNICODE_DASHES, '').replace(/^-+/, '')}"?`,
    )
  }
  return false
}

/** A week. Long enough that a run an operator might still want to read is not swept up. */
const PRUNE_DEFAULT_DAYS = 7

/**
 * `--days N`, or the default.
 *
 * Validated strictly and BEFORE anything is deleted, because there is no way to be sorry
 * afterwards. `--days` with nothing after it is the case that matters most: read loosely, a
 * missing value becomes `NaN`, `NaN` comparisons are all false, and a cutoff of `NaN` deletes
 * nothing -- which looks exactly like success and would teach an operator that their records
 * were already clean.
 *
 * Zero is accepted and means "everything that qualifies", which is a real request after a
 * day of failed starts. Negative is refused rather than clamped: a cutoff in the future is
 * not a thing anyone meant to ask for, and guessing which end they meant is how a prune
 * deletes a session that finished ten minutes ago.
 */
function pruneArgs(flags: string[]): { days: number; json: boolean } | { error: string } {
  const accepted = 'sessions --prune accepts --days <n> and --json'
  let days: number | undefined
  let json = false
  let prune = false
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!
    if (f === '--prune') {
      if (prune) return { error: `--prune given twice` }
      prune = true
    } else if (f === '--json') {
      if (json) return { error: `--json given twice` }
      json = true
    } else if (f === '--days') {
      // Repeated rather than last-wins. `--days 30 --days 0` has two readings and only one
      // of them is recoverable, so it is refused instead of guessed at.
      if (days !== undefined) return { error: `--days given twice` }
      const raw = flags[++i]
      // Digits, not `Number()`: it reads '' as 0, and `parseFloat` reads '3 weeks' as 3.
      if (raw === undefined || !/^\d+(\.\d+)?$/.test(raw)) {
        return {
          error:
            `--days needs a number of days that is zero or more` +
            `${raw === undefined ? ' and there is nothing after it' : `, not "${raw}"`}`,
        }
      }
      days = Number(raw)
    } else {
      // Everything else, flag-shaped or not. This is the whole reason the parser is a loop
      // rather than three `includes` calls: `--dasy 0` has no `--days` in it, so a lenient
      // parser drops the typo AND the `0`, silently falls back to seven days, and deletes a
      // week of records the operator was trying to spare. An unrecognised token near a
      // destructive command is a mistake, not a preference.
      return { error: `unexpected argument "${f}" — ${accepted}` }
    }
  }
  return { days: days ?? PRUNE_DEFAULT_DAYS, json }
}

/**
 * Delete the records of sessions that are over and gone.
 *
 * The ids are printed BEFORE the first deletion, from `pruneSessions`'s announcement rather
 * than from its return value — a list printed after the fact would describe files that are
 * already gone, and would tell the operator nothing at all if the process died partway.
 *
 * Then every id is printed AGAIN as an outcome. The two lists are not the same claim: the
 * first says what was chosen, the second says what actually went, and between them sit a
 * liveness re-check and a filesystem that can refuse. An operator who saw only the first
 * would have to assume the rest.
 *
 * Under `--json` the announcement goes to stderr rather than being dropped. The combination
 * is refused nowhere because it is a reasonable thing to want — `sessions --json` already
 * exists — and stdout has to carry the result object ALONE or the mode is useless. Announcing
 * on stderr keeps both: the promise that nothing is deleted unannounced, and a parseable
 * stdout. A consumer redirecting stderr to a log is exactly who wants that record.
 *
 * Failures exit non-zero. A prune is usually run to reclaim a directory or to unstick
 * something, and one that reported a permission error and exited 0 would be discovered by
 * whatever ran next.
 */
function prune(root: string, flags: string[]): number {
  const wanted = pruneArgs(flags)
  if ('error' in wanted) {
    console.error(`conclave: ${wanted.error}`)
    return 1
  }
  const { days, json } = wanted
  // Nothing above this line has touched the filesystem: an argument list that does not parse
  // is refused before a cutoff is even computed, let alone a record chosen.
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const say = json ? (line: string) => console.error(line) : (line: string) => console.log(line)
  const result = pruneSessions(root, cutoff, {
    announce: (ids) => {
      if (ids.length === 0) {
        say(`no session records are older than ${days}d and finished`)
        return
      }
      say(`pruning ${ids.length} session record${ids.length === 1 ? '' : 's'}:`)
      for (const id of ids) say(`  ${id}`)
    },
  })
  if (json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    // One line per candidate, naming it. An operator shown three candidates and a count of
    // two is left to work out which one survived, and "its process is alive" is a fact about
    // their machine rather than noise.
    for (const id of result.removed) console.log(`removed ${id}`)
    for (const s of result.skipped) console.log(`kept ${s.id}: ${s.reason}`)
  }
  for (const f of result.failed) console.error(`conclave: could not remove ${f.id}: ${f.error}`)
  return result.failed.length > 0 ? 1 : 0
}

/**
 * Print a session's event stream, optionally following it.
 *
 * Reads the file rather than attaching to the process, for the reason `sessionRecord`
 * gives at length: the stream is on disk precisely so a reader needs nothing from a run
 * that may already be gone. Following is a poll on file size — the events file is
 * append-only, so a growing file has only ever gained whole lines behind the last newline.
 *
 * `fs.watch` was the obvious alternative and is not portable enough to rely on: it misses
 * changes on some network filesystems and coalesces others, and a follower that silently
 * stops is worse than one that polls.
 */
async function streamEvents(found: ReadSession, follow: boolean): Promise<number> {
  const path = found.status.eventsPath
  if (!existsSync(path)) {
    console.error(`conclave: no events recorded for ${found.status.id}`)
    return 1
  }
  let offset = 0
  const drain = () => {
    const size = statSync(path).size
    if (size <= offset) return
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(size - offset)
      readSync(fd, buf, 0, buf.length, offset)
      const text = buf.toString('utf8')
      // A trailing partial line is expected: the writer appends whole lines but a reader
      // can arrive between the write and its newline. Everything up to the last newline is
      // complete; the remainder waits for the next pass.
      const cut = text.lastIndexOf('\n')
      if (cut < 0) return
      offset += Buffer.byteLength(text.slice(0, cut + 1))
      for (const line of text.slice(0, cut).split('\n')) if (line) console.log(line)
    } finally {
      closeSync(fd)
    }
  }
  drain()
  if (!follow) return 0
  // Stops when the session does, so `--follow` terminates on its own rather than requiring
  // a Ctrl-C -- which a script driving this cannot send.
  for (;;) {
    await new Promise((r) => setTimeout(r, 250))
    drain()
    const now = readSession(projectRootFor(process.cwd()), found.status.id)
    if (!now || now.status.state === 'ended' || now.abandoned) {
      drain()
      return 0
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, sub, ...rest] = argv

  // Before dispatch, for every command rather than per-command. `relay` grew its own help
  // guard after `conclave relay --help` launched two real agent sessions and billed for
  // asking an advisor what `--help` means; `session` never had one, so `conclave session
  // --help` read the flag as "no goal, some flags" and opened a live console instead. Any
  // command asked what it does must answer, and a guard each command has to remember is a
  // guard some command will not.
  //
  // Exact matches only: a goal is one argv entry, so a goal MENTIONING `--help` never
  // equals it.
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }

  if (command === 'config' && sub === 'show') {
    // Deliberately not routed through `installConfig`, even for the drift status they
    // both compute: a dry-run install filters by agent and fails on the first missing
    // template, so it would report a broken Conclave in place of the roots that were
    // asked for. `showConfig` does the same comparison per target and keeps going.
    const report = showConfig()
    console.log(rest.includes('--json') ? formatConfigShowJson(report) : formatConfigShow(report))
    // Always zero, drift included. `show` describes; `config check` is the gate, and
    // having two commands exit non-zero on the same condition invites gating on this one
    // by accident — which would then also fail for a permission mode somebody chose.
    return 0
  }

  if (command === 'config' && sub === 'check') {
    const result = await installConfig({
      ...agentsFromFlags(rest),
      dryRun: true,
      diagnose: !rest.includes('--no-diagnose'),
    })
    // `--json` changes only the rendering. The exit code is the contract a caller gates
    // on, and it must not depend on which format was asked for.
    console.log(rest.includes('--json') ? formatInstallResultJson(result) : formatInstallResult(result))
    // Non-zero on drift so this is usable as a gate before fixture collection.
    return hasDrift(result) ? 1 : 0
  }

  if (command === 'config' && sub === 'install') {
    const result = await installConfig({
      ...agentsFromFlags(rest),
      diagnose: !rest.includes('--no-diagnose'),
    })
    console.log(formatInstallResult(result))

    // Opt-in, and announced line by line. This writes the operator's GLOBAL Codex config to
    // grant command execution in a directory — heavier than anything else this command
    // does, and not something to infer from their having run an installer.
    if (rest.includes('--trust')) {
      const seeded = await seedCodexTrust(result.projectRoot)
      console.log('')
      if (seeded.added.length === 0) console.log('Codex trust was already recorded; nothing added.')
      else {
        console.log('Recorded in ~/.codex/config.toml:')
        for (const a of seeded.added) console.log(`  ${a}`)
      }
      console.log(seeded.ready ? 'Codex hooks are now executable.' : 'Codex still reports them as not executable.')
    }
    // A checkout needing its first trust decision is not a failure, so this does not
    // exit non-zero on `retrustRequired` alone.
    return 0
  }

  if (command === 'guard') {
    // `guard` takes no subcommand, so its own flags arrive in `sub` as well as `rest`.
    const flags = [sub, ...rest]
    const report = guard(process.cwd())
    // As with `config check --json`: the format is a rendering choice, and the exit code
    // below — which is what a commit helper gates on — must not depend on it.
    if (flags.includes('--json')) {
      console.log(formatGuardReportJson(report))
    } else if (!report.live && !report.stale) {
      console.log('no participant sessions are live')
    } else {
      for (const m of report.messages) console.log(m)
    }
    // Stale exits 0: a crashed run must not block the repository forever, but it is
    // reported so the files can be accounted for rather than silently absorbed.
    return report.live ? 1 : 0
  }

  if (command === 'sessions') {
    const root = projectRootFor(process.cwd())
    const flags = [sub, ...rest].filter((f): f is string => f !== undefined)
    if (flags.includes('--prune')) return prune(root, flags)
    if (flags.includes('--days')) {
      // Named rather than ignored. `--days 3` alone reads like it does something, and a
      // listing that quietly printed everything would look like the prune had found nothing
      // to delete -- which is the one wrong answer an operator would act on.
      console.error('conclave: --days only means something with --prune')
      return 1
    }
    const all = listSessions(root)
    if (rest.includes('--json') || sub === '--json') {
      console.log(JSON.stringify(all.map((s) => ({ ...s.status, alive: s.alive, abandoned: s.abandoned })), null, 2))
      return 0
    }
    if (all.length === 0) {
      console.log('no sessions have been recorded in this project')
      return 0
    }
    const now = Date.now()
    for (const s of all) console.log(formatSessionLine(s, now))
    return 0
  }

  if (command === 'status') {
    const root = projectRootFor(process.cwd())
    // The id is optional and means the most recent, which is what an operator running one
    // session at a time always means. An ambiguous prefix is refused rather than resolved.
    const wanted = sub && !sub.startsWith('--') ? sub : undefined
    const found = resolveSession(root, wanted)
    if ('error' in found) {
      // A directory with no status.json is its own condition, and a different one from "no
      // such session": it means the id WAS issued and the process never got far enough to
      // describe itself. Saying "no sessions recorded" there sends the operator looking for
      // a typo instead of at the one file that holds the answer.
      const dir = wanted ? sessionDir(root, wanted) : undefined
      if (dir && existsSync(dir)) {
        console.error(
          `conclave: session ${wanted} was started but never recorded its state — ` +
            `it most likely died during startup. What it printed is in ${join(dir, 'stdio.log')}`,
        )
        return 1
      }
      console.error(`conclave: ${found.error}`)
      return 1
    }
    const flags = [sub, ...rest]
    if (flags.includes('--json')) {
      console.log(formatSessionJson(found.session))
    } else {
      console.log(formatSession(found.session, Date.now()))
    }
    // Non-zero for a run that claimed to be going and is not, so a script polling this can
    // gate on it. A finished run is a success however it finished -- the OUTCOME is in the
    // record, and conflating "did not survive" with "ended badly" would make both unusable.
    return found.session.abandoned ? 1 : 0
  }

  if (command === 'events') {
    const root = projectRootFor(process.cwd())
    const wanted = sub && !sub.startsWith('--') ? sub : undefined
    const found = resolveSession(root, wanted)
    if ('error' in found) {
      console.error(`conclave: ${found.error}`)
      return 1
    }
    const flags = [sub, ...rest]
    return await streamEvents(found.session, flags.includes('--follow') || flags.includes('-f'))
  }

  if (command === 'relay') {
    const goal = sub
    // A flag in the goal position is FLAGS, not a goal. `--help` and `-h` are already
    // answered before dispatch; what is left here is every OTHER flag typed where the goal
    // belongs, which is a mistake worth naming rather than starting a run over.
    if (!goal || goal.startsWith('-')) {
      console.error(
        goal
          ? `relay: "${goal}" looks like a flag, not a goal. The goal comes first:\n\n` +
              `  conclave relay "<goal>" [--lead codex] [--implementer claude]\n`
          : 'relay needs a goal: conclave relay "<goal>"\n',
      )
      return 1
    }
    const flag = (name: string, fallback: string) => {
      const i = rest.indexOf(`--${name}`)
      return i >= 0 ? (rest[i + 1] ?? fallback) : fallback
    }
    const registry = defaultRegistry()
    // Everything a human would read goes to STDERR under --json, so stdout carries the
    // report and nothing else. A consumer that had to strip log lines out of a JSON stream
    // is a consumer that will eventually strip the wrong one.
    const asJson = rest.includes('--json')
    const say = (line: string) => (asJson ? console.error(line) : console.log(line))
    // `--advisor`, because that is the word every other surface uses: the seat id, the
    // routing log, the console's `>advisor`, and the briefing itself. `--lead` was the
    // RelayOptions FIELD name leaking into the CLI, and it is kept as an alias so existing
    // scripts do not break.
    const lead = flag('advisor', '') || flag('lead', 'codex')
    const implementer = flag('implementer', 'claude')
    const checks = parseChecks(
      flag('checks', ''),
      flag('checks-informational', ''),
      flag('checks-unrelated', ''),
    )

    // `.conclave/config.json` is a property of the PROJECT, not of which front-end opened
    // it. Reading it only in the console meant an unattended run ignored the permission
    // mode the operator had configured — and an unattended run is the one with nobody to
    // answer a prompt it then stops at.
    const runStartedAt = Date.now()

    if (!rejectUnicodeDashes(rest)) return 1

    // Before anything is spawned, registered or written. The failure being guarded is an
    // operator who did not intend to start a run at all, and every line of setup below is
    // work done on their behalf in a directory they did not mean to be in.
    const refusals = preflightRefusals(process.cwd(), { force: rest.includes('--force') })
    for (const r of refusals) console.error(`conclave: ${r.reason}\n  ${r.remedy}`)
    if (refusals.length > 0) return 1

    // Warned about before anything starts, refused only if asked. A bad goal is sometimes a
    // deliberate probe, and a check that blocks work becomes a check people route around.
    const goalFindings = lintGoal(goal)
    if (goalFindings.length > 0) {
      for (const line of formatGoalFindings(goalFindings)) console.error(line)
      if (rest.includes('--strict-goal')) {
        console.error('conclave: refusing to start (--strict-goal)')
        return 1
      }
    }

    /**
     * Hand the run to a background process and return its id.
     *
     * Re-executes this same binary with `--detach` stripped and `--detached-id` in its
     * place, rather than forking a worker: the child is then an ordinary `conclave relay`
     * in every respect, including how it records, how it fails, and how it is resumed. A
     * second code path for detached runs would be a second thing to keep correct, and the
     * one that runs unattended is the one nobody is watching when it drifts.
     *
     * stdio goes to a file rather than being discarded. `events.ndjson` is the structured
     * account, and it is not the whole account: a crash before the relay starts, a Node
     * stack trace, an adapter writing to stderr -- all of that lands here and nowhere else.
     * A detached run whose failure left no trace would reproduce the problem this is for.
     */
    if (rest.includes('--detach') && rest.includes('--dry-run')) {
      console.error(
        'conclave: --detach and --dry-run contradict each other. A dry run resolves ' +
          'everything and starts nothing, so there is no run to hand to a background ' +
          'process. Drop one.',
      )
      return 1
    }
    if (rest.includes('--detach')) {
      const id = newSessionId(runStartedAt, process.pid)
      const root = projectRootFor(process.cwd())
      const dir = sessionDir(root, id)
      mkdirSync(dir, { recursive: true })
      const logFile = join(dir, 'stdio.log')
      const fd = openSync(logFile, 'a')
      const argvOut = ['relay', goal, ...rest.filter((a) => a !== '--detach'), '--detached-id', id]
      const child = spawn(process.execPath, [process.argv[1]!, ...argvOut], {
        cwd: process.cwd(),
        detached: true,
        stdio: ['ignore', fd, fd],
      })
      // Unreferenced AND detached: without both, this process waits for a child it has
      // deliberately stopped owning, which is the opposite of detaching.
      child.unref()
      closeSync(fd)
      // The parent writes the first status, carrying the CHILD's pid.
      //
      // Without this there is a window -- launching two CLIs, seconds long -- in which the
      // operator holds an id that `conclave status` reports as no such session. Worse, a
      // child that dies before the relay starts leaves that state permanently, so the id
      // they were handed never resolves and the failure has to be found in stdio.log by
      // someone who does not yet know to look. With it, the same failure reads as
      // `abandoned` the moment the pid is gone, which is exactly what happened.
      new SessionRecorder(root, {
        id,
        pid: child.pid ?? process.pid,
        cwd: process.cwd(),
        goal,
        front: 'relay',
        operator: flag('operator', '') === 'agent' ? 'agent' : 'human',
        state: 'starting',
        startedAt: runStartedAt,
        messages: 0,
        participants: [],
      })
      if (asJson) {
        console.log(JSON.stringify({ detached: true, id, pid: child.pid, dir, stdio: logFile }, null, 2))
      } else {
        console.log(id)
        console.error(`  detached as pid ${child.pid}`)
        console.error(`  conclave status ${id}`)
        console.error(`  conclave events ${id} --follow`)
        console.error(`  stdio: ${logFile}`)
      }
      return 0
    }

    // Parsed early so this run sees its own flag; written later, once it is going to start.
    const bypass = bypassRequest(rest)
    const projectConfig = withBypass(readProjectConfig(process.cwd()), bypass)
    // Config-derived args first, then per-invocation ones, so an explicit flag wins.
    const leadArgs = [...launchArgsFor(projectConfig, lead), ...extraArgs(flag('advisor-args', '') || flag('lead-args', ''))]
    const implArgs = [
      ...launchArgsFor(projectConfig, implementer),
      ...extraArgs(flag('implementer-args', '')),
    ]
    const bypassing = [lead, implementer].filter((a) => permissionModeFor(projectConfig, a) === 'bypass')
    if (bypassing.length > 0) {
      say(`  permission prompts bypassed for ${[...new Set(bypassing)].join(', ')} — per ${CONFIG_RELATIVE}`)
    }

    // Register before starting, as the console does. `relay` refused at the preflight in a
    // project that had never run Conclave — correctly, but with an instruction where an
    // action belonged, and inconsistently with the other front-end. Registration is a
    // precondition for the tool to work at all, not a decision; what IS a decision is
    // editing someone's .gitignore, which is why the un-ignored paths are reported instead.
    const registered = await installConfig({
      projectRoot: process.cwd(),
      agents: [...new Set([lead, implementer])].filter((a): a is AgentKind =>
        (AGENT_KINDS as string[]).includes(a),
      ),
      diagnose: false,
    })
    for (const w of registered.written.filter((w) => w.changed)) {
      say(`  registered ${w.label}: ${w.path}`)
    }
    if (registered.unignored.length > 0) {
      say(`  not ignored by this project: ${registered.unignored.join(', ')}`)
    }

    // Registration is not enough, and this front-end never did the second half. An
    // unattended run in a fresh project wrote a sidecar Codex would not execute, with
    // nobody present to answer the prompt that would have fixed it -- and the failure
    // surfaces as `transport_failed` at the first turn, whose message sends the operator
    // to `config check`, which reports the hooks as registered. The command designed to
    // run without a human was the one missing the step that removes the need for one.
    await ensureCodexHooksTrusted({
      projectRoot: process.cwd(),
      agents: [lead, implementer].filter((a): a is AgentKind => (AGENT_KINDS as string[]).includes(a)),
      say,
      // Appended rather than redrawn: this is the unattended form, its output is usually a
      // file, and a spinner in a log is noise. It still says something, because a silent
      // minute waiting on a Codex TUI is indistinguishable from a hang.
      slow: async (label, detail, work) => {
        say(`  ${label} · ${detail}`)
        return work()
      },
    })

    say(
      checks.length > 0
        ? `  rotation armed — a degraded implementer will be replaced, verified by: ${checks.map((c) => (typeof c === 'string' ? c : `${c.command} [${c.relevance}]`)).join(', ')}`
        : '  rotation NOT armed — no --checks, so degradation escalates instead of rotating',
    )

    // Recorded continuously into a gitignored directory, because a record written on exit
    // is exactly the record a crash destroys -- and a crash is one of the endings a resume
    // exists for. Named for when the run started, so a directory listing is chronological.
    const recordPath =
      flag('record', '') || join(process.cwd(), '.conclave', 'runs', `relay-${runStartedAt}.ndjson`)
    const recorder = new RunLogWriter(recordPath)

    const resumeFrom = flag('resume', '')
    if (resumeFrom && !runLogExists(resumeFrom)) {
      console.error(`conclave: no run log at ${resumeFrom}`)
      return 1
    }
    const prior = resumeFrom ? readRunLog(resumeFrom) : []
    if (prior.length > 0) {
      say(`  resuming from ${resumeFrom} — ${prior.length} messages replayed into both seats`)
    }

    // AFTER the preflight refusals, the goal lint and the dry-run short-circuit, and before
    // anything is spawned. Writing permissive mode into a project on a run that then refuses
    // to start -- or that was only ever a dry run -- leaves a consequential setting behind
    // from an invocation that reported doing nothing.
    if (!rest.includes('--dry-run') && !applyBypassFlag(rest, say)) return 1

    if (rest.includes('--dry-run')) {
      // Everything above this line is resolution: config read, checks parsed, args composed.
      // Nothing below it is, so this is the last point at which nothing has been spawned.
      //
      // Respects --json for the same reason the report does: an agent operator checking what
      // WOULD run is exactly the caller most likely to be parsing, and handing it prose
      // because it also passed --dry-run would be the trap this mode exists to avoid.
      const plan = {
        dryRun: true,
        cwd: process.cwd(),
        goal,
        advisor: { agent: lead, args: leadArgs },
        implementer: { agent: implementer, args: implArgs },
        checks: checks.map((c) =>
          typeof c === 'string'
            ? { command: c, relevance: 'required' }
            : { command: c.command, relevance: c.relevance },
        ),
      }
      if (asJson) {
        console.log(JSON.stringify(plan, null, 2))
      } else {
        say('dry run — nothing was started')
        say(`  cwd:         ${plan.cwd}`)
        say(`  advisor:     ${lead}${leadArgs.length ? ` ${leadArgs.join(' ')}` : ''}`)
        say(`  implementer: ${implementer}${implArgs.length ? ` ${implArgs.join(' ')}` : ''}`)
        say(
          `  checks:      ${
            plan.checks.length
              ? plan.checks.map((c) => `${c.command} [${c.relevance}]`).join(', ')
              : 'none — rotation not armed'
          }`,
        )
        say(`  goal:        ${goal}`)
      }
      return 0
    }

    const relay = await Relay.start({
      registry,
      cwd: process.cwd(),
      ...(prior.length > 0 ? { resume: prior } : {}),
      ...(flag('operator', '') === 'agent' ? { operator: 'agent' as const } : {}),
      lead: { id: 'advisor', agent: lead, role: 'advisor', ...(leadArgs.length > 0 ? { args: leadArgs } : {}) },
      implementer: {
        id: 'implementer',
        agent: implementer,
        role: 'implementer',
        ...(implArgs.length > 0 ? { args: implArgs } : {}),
      },
      maxRounds: Number(flag('rounds', '4')),
      ...(flag('max-turns', '') || flag('max-minutes', '')
        ? {
            ceilings: {
              ...(flag('max-turns', '') ? { maxTurns: Number(flag('max-turns', '')) } : {}),
              ...(flag('max-minutes', '')
                ? { maxDurationMs: Number(flag('max-minutes', '')) * 60_000 }
                : {}),
            },
          }
        : {}),
      // Without these, degradation has nothing to verify a replacement against, so the run
      // ESCALATES and ends rather than rotating. An unattended form that cannot rotate
      // cannot exercise the mechanism it exists to run unattended.
      ...(checks.length > 0 ? { rotation: { checks } } : {}),
      // A fixed window cannot serve both a chat-sized turn and one running a full test
      // suite plus a review. It existed on RelayOptions and was reachable from nowhere.
      ...(flag('settle', '') ? { transcriptSettleMs: Number(flag('settle', '')) * 1000 } : {}),
      // Its own flag rather than a multiple of --settle. The two are budgets against
      // different costs: --settle is paid on every turn and must stay small, this is paid
      // only when the alternative is discarding a turn's whole report (#39).
      ...(flag('salvage', '') ? { transcriptSalvageMs: Number(flag('salvage', '')) * 1000 } : {}),
      // The routing log is the only complete account of the session, so it is printed as
      // it happens rather than assembled at the end.
      onLog: (m) => {
        recorder.write(m)
        if (m.visibility === 'internal') {
          say(`  · ${m.text}`)
          return
        }
        const arrow = m.to.length ? `-> ${m.to.join(', ')}` : '-> (recorded only)'
        // Loud only for a genuine restriction. Ordinary point-to-point routing is not
        // hidden influence, and saying so on every line would make the label useless.
        const flag =
          m.visibility === 'restricted' ? `  RESTRICTED — withheld from ${m.excluded.join(', ')}` : ''
        say(`\n[${m.seq}] ${m.from} (${m.fromRank}) ${arrow}${flag}`)
        say(m.text.trim().split('\n').map((l) => `    ${l}`).join('\n'))
      },
    })
    // Readable from outside the process for as long as it runs, and after it stops. Written
    // for every run, not only detached ones: a foreground run is the one an agent operator
    // launches into a background file and reads with `tail`, which is the workaround #26
    // exists to remove.
    const recording = recordSession(relay, {
      repoRoot: projectRootFor(process.cwd()),
      // The id the parent PRINTED when detaching, not a fresh one. A detached run that
      // recorded itself under a different id than the operator was handed is a session
      // they cannot find -- and `conclave status <id>` would report no such session while
      // the run was going perfectly.
      id: flag('detached-id', '') || newSessionId(runStartedAt, process.pid),
      goal,
      front: 'relay',
      startedAt: runStartedAt,
      logPath: recordPath,
    })
    say(`  session: ${recording.id} — conclave status ${recording.id}`)
    recording.set('running')

    let failed = false
    // Before the run, not after the relay is built: a report whose duration excluded startup
    // would understate how long the operator actually waited.
    try {
      const outcome = await relay.run(goal)
      recording.set('ended', { outcome })
      if (asJson) {
        // stdout, alone, parseable in full. The prose lines below still go to stderr, so a
        // human watching a --json run is not left staring at nothing.
        console.log(JSON.stringify(await runReport(relay, { goal, outcome, startedAt: runStartedAt }), null, 2))
      }
      say(`\n=== relay ended: ${outcome.reason}${outcome.detail ? ` — ${outcome.detail}` : ''}`)
      failed = outcome.reason === 'transport_failed' || outcome.reason === 'ceiling'
    } catch (err) {
      // Belt and braces. The relay converts transport failures into outcomes now, so this
      // should be unreachable -- but the operator's record must not depend on that being
      // true. The summary lines below used to sit after a throw and were simply lost.
      console.error(`\n=== relay ended: transport_failed — ${err instanceof Error ? err.message : String(err)}`)
      // Recorded on this path too. A status left at `running` by a run that threw is the
      // exact abandoned-looking record `readSession` has to reconcile against a pid, and
      // there is no reason to make it guess when we know.
      recording.set('ended', {
        outcome: { reason: 'transport_failed', detail: err instanceof Error ? err.message : String(err) },
      })
      failed = true
    } finally {
      // Printed on every run, including — especially — the ones where nothing happened or
      // something broke. A null is only evidence if the instrument is known to have been
      // live, and the runs most worth diagnosing are the ones that used to report least.
      say(`=== ${relay.log.length} messages routed`)
      say(`=== ${relay.rotationSummary()}`)
      // Last useful line for a human, and the one that makes an abnormal ending recoverable.
      say(`=== run log: ${recordPath}`)
      say(`===   resume with: conclave relay "<goal>" --resume ${recordPath}`)
      // Last, so it is the final thing on screen. A `done` that carries an unresolved
      // caveat must not read as an unqualified success to someone who only reads the tail.
      for (const line of relay.flagSummary()) say(`=== ${line}`)
      // Only when it is worth a look. Printing "0 worktrees" on every run that never
      // delegated would train the reader to skip the line that matters.
      const sub = relay.subagentUse()
      if (sub.delegated && sub.worktreesCreated.length === 0) {
        say('=== subagents were used and no git worktree was created — worth a look if any of')
        say('===   them modified the shared working directory')
      }
      await relay.stop()
      // AFTER the relay, never before: stopping the relay is what closes the event stream,
      // and closing the recorder first would cut the terminal `run_end` off mid-flight.
      await recording.close()
    }
    return failed ? 1 : 0
  }

  if (command === 'session') {
    // The goal is optional: without one the console comes up and waits, and the first
    // thing typed starts the run. So a flag in the first position is not a goal named
    // `--lead` — it is a session with no goal and some flags, which is legitimate.
    const args = [sub, ...rest].filter((a): a is string => a !== undefined)
    if (!rejectUnicodeDashes(args)) return 1
    const goal = args[0] && !args[0].startsWith('--') ? args[0] : undefined
    // A goal written AFTER a flag is not picked up -- the goal is args[0] by design, because
    // `session` legitimately starts with no goal at all. Saying so is the fix: silently
    // waiting at an empty prompt while the operator's sentence sits unused in argv reads as
    // the console having ignored them.
    if (!goal) {
      const stray = args.find(
        (a, i) => i > 0 && !a.startsWith('--') && (args[i - 1] ?? '').startsWith('--') === false,
      )
      if (stray) {
        console.error(
          `conclave: "${stray}" is not being used. A goal must come first: ` +
            `conclave session "<goal>" [flags]. Starting without one; type it at the prompt.`,
        )
      }
    }
    let bad: string | undefined
    const flag = (name: string, fallback: string) => {
      const i = args.indexOf(`--${name}`)
      if (i < 0) return fallback
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) {
        bad = name
        return fallback
      }
      return value
    }
    const checks = parseChecks(
      flag('checks', ''),
      flag('checks-informational', ''),
      flag('checks-unrelated', ''),
    )
    const lead = flag('advisor', '') || flag('lead', 'codex')
    const implementer = flag('implementer', 'claude')
    const rounds = flag('rounds', '8')
    // The same flag `relay` has. Its absence here is what made an agent pick the front-end
    // that cannot hold a pause -- see SessionOptions.operator.
    const operator = flag('operator', '') === 'agent' ? ('agent' as const) : undefined
    const force = args.includes('--force')
    // All three existed on `relay` and were unreachable here. `--record` is the starkest:
    // `SessionOptions.record` is documented as the way to inspect a rendering fault in the
    // bytes rather than from a screenshot, and no invocation could switch it on.
    const settle = flag('settle', '')
    const salvage = flag('salvage', '')
    const record = flag('record', '')
    const resume = flag('resume', '')
    const turnTimeout = flag('turn-timeout', '')
    const leadArgs = extraArgs(flag('advisor-args', '') || flag('lead-args', ''))
    const implementerArgs = extraArgs(flag('implementer-args', ''))
    // Both front-ends, together. Wiring a capability into one and not the other is the
    // mistake this codebase has now made six times.
    // The console applies and persists together: unlike `relay` there is no dry run and no
    // preflight refusal, so the point of no return is here.
    if (!applyBypassFlag(args, (l) => console.log(l))) return 1
    if (bad) {
      console.error(
        `--${bad} was given without a value.\n\n` +
          `If you used \`npm run session -- ...\`, npm mangles quoted arguments containing\n` +
          `spaces. Call the binary directly instead:\n\n` +
          `  node bin/conclave.ts session "<goal>" --checks "npm test"\n`,
      )
      return 1
    }
    return runSession({
      cwd: process.cwd(),
      ...(operator ? { operator } : {}),
      ...(force ? { force } : {}),
      ...(settle ? { transcriptSettleMs: Number(settle) * 1000 } : {}),
      ...(salvage ? { transcriptSalvageMs: Number(salvage) * 1000 } : {}),
      ...(record ? { record } : {}),
      ...(resume ? { resume } : {}),
      ...(goal === undefined ? {} : { goal }),
      lead,
      implementer,
      rounds: Number(rounds),
      checks,
      ...(leadArgs.length > 0 ? { leadArgs } : {}),
      ...(implementerArgs.length > 0 ? { implementerArgs } : {}),
      version: version(),
      ...(turnTimeout ? { turnWatchdogMs: Number(turnTimeout) * 1000 } : {}),
    })
  }

  if (command === 'demo') {
    const i = [sub, ...rest].indexOf('--record')
    const record = i >= 0 ? [sub, ...rest][i + 1] : undefined
    const { runDemo } = await import('../src/repl/demo.ts')
    return runDemo({ record })
  }

  if (command === '--version' || command === 'version') {
    console.log(version())
    return 0
  }

  if (command === 'help' || command === '--help' || command === undefined) {
    console.log(USAGE)
    return 0
  }

  console.error(`unknown command: ${[command, sub].filter(Boolean).join(' ')}\n`)
  console.error(USAGE)
  return 1
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`conclave: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)
