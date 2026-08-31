#!/usr/bin/env node
/**
 * Conclave CLI. Currently one subcommand; the shape is here so `config install` does not
 * end up as an ad-hoc script that only its author knows to run.
 */

import {
  AGENT_KINDS,
  formatCheckNotApplicable,
  formatCheckNotApplicableJson,
  formatInstallResult,
  formatInstallResultJson,
  hasDrift,
  installConfig,
  notApplicableInSeatWorktree,
  resolveRepoRoot,
  type AgentKind,
} from '../src/config/install.ts'
import { seatWorktreeAt } from '../src/workspace/worktrees.ts'
import {
  CONFIG_RELATIVE,
  CONFIGURABLE_AGENTS,
  launchArgsFor,
  permissionModeFor,
  readProjectConfig,
  setPermissionMode,
} from '../src/config/project.ts'
import { formatConfigShow, formatConfigShowJson, showConfig } from '../src/config/show.ts'
import {
  beforeEndOfOptions,
  extraPositionalMessage,
  flagReader,
  missingValueMessage,
  parseArgv,
  unknownFlagMessage,
} from '../src/config/cliFlags.ts'
import type { FlagSurface } from '../src/config/cliFlags.ts'
import type { CheckSpec } from '../src/rotation/record.ts'
import type { ProjectConfig } from '../src/config/project.ts'
import { runReport } from '../src/relay/report.ts'
import { reportedTargeting } from '../src/relay/targeting.ts'
import { dryRunPlan, dryRunPlanLines, type DryRunPlanInput } from '../src/relay/dryRunPlan.ts'
import { RunLogWriter, readRunLog, runLogExists } from '../src/relay/resume.ts'
import {
  ceilingSummary,
  ceilingsFrom,
  effectiveCeilings,
  preflightRefusals,
  preflightWarnings,
} from '../src/relay/guardrails.ts'
import { absoluteSummary, resolveDeadlines, silenceSummary } from '../src/relay/deadlines.ts'
import { ensureCodexHooksTrusted } from '../src/deployment/ensureTrust.ts'
import type { ReadSession } from '../src/workspace/sessionRecord.ts'
import { execFileSync, spawn } from 'node:child_process'
import { exitAfterFlush } from '../src/process/exit.ts'
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
import { version } from '../src/version.ts'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedCodexTrust } from '../src/deployment/codexHookTrust.ts'
import { defaultRegistry } from '../src/registry/builtin.ts'
import { rolesWithDefined } from '../src/registry/roles.ts'
import type { AgentRegistry } from '../src/registry/registry.ts'
import { runSession } from '../src/repl/session.ts'
import { boundOf, implementerSeatPlan, implementerSpecsFor, Relay, reviewerSpecFor, type SeatRequest } from '../src/relay/relay.ts'
import { formatGuardReportJson, guard } from '../src/workspace/sessionLock.ts'
import { Broker } from '../src/notify/broker.ts'
import { resolveTransport, transportNames } from '../src/notify/registry.ts'
import type { Outbound } from '../src/notify/types.ts'
import {
  begin as beginMutation,
  end as endMutation,
  outstanding as outstandingMutations,
  restore as restoreMutation,
} from '../src/workspace/mutationMarker.ts'

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
    /continue /rotate /abort        answer a pause. /rotate REQUIRES a reason and records it
                                    — unless the pause is a rotation candidate, where taking
                                    it is agreement, so the record keeps the proxy's own
                                    words and the one you typed is not kept (#75)
    /wait [minutes]                 keep waiting, when the child still has CPU. Records
                                    the decision, sends nothing, leaves the run paused
    /allow /deny                    answer a permission prompt
    /pause /state /log /exit        drive and inspect
    >advisor ... / >implementer ... send a message to one seat. ANY seat, by the id it
    >implementer-2 ...              answers to -- /state names them; an id no seat has is
                                    refused, naming the ones that exist, not sent to all
    anything else                   the goal, if none has been given yet

  One line is one message. An answer that spans lines needs framing, or each line
  becomes a message of its own -- addressed to everyone, since only the first line
  carries the prefix, and resuming the run on whichever line got there first:
    <<EOF                           open a block, alone or after >both or a seat
    ...                             id -- and only those, so a
    EOF                             message or a slash command ending in <<word
                                    is unchanged. Everything up to a line equal to
                                    EOF is ONE message, blank lines kept. Closing
                                    stdin mid-block delivers nothing and says so.
  So an answer to a pause is written:
    printf '>implementer <<EOF\\n%s\\nEOF\\n' "$(cat answer.txt)" > "$fifo"

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
  transport_failed, peer_busy, invariant_violated or a ceiling. guard is non-zero
  while participants are live.

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
                                   prose; the exit code is unchanged. Inside a Conclave
                                   seat worktree it reports not_applicable and exits zero:
                                   registrations are git-ignored, so a seat never holds
                                   them and only the run root can be checked.
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
  notify         tell|ask "<headline>" [--options id:Label,...] [--kind ...]
                 [--href URL] [--run <id>] [--transport <name>] [--operator human]
                 vetoes [--transport <name>] | log [--json]
                                   Reach a human when an agent is operating. "tell" is one way
                                   and never waits; "ask" waits and prints the answer as JSON.
                                   An action is an id that was offered; free text comes back as
                                   text for the caller to interpret. "log" is what was asked and
                                   who answered.
  skill          [install] [--force]
                                   The operator skill: how to start a run, read it without
                                   scraping the console, answer a pause, and act on how it
                                   ended. Bare, it says where the skill is; "install" copies
                                   it into ~/.claude/skills. Never installed for you.
  mutations      [begin|end|restore <path>] [--note "..."]
                                   Track files that are deliberately broken for mutation
                                   testing, so a crash between breaking one and restoring
                                   it leaves a record instead of a diff that looks like
                                   work in progress (#181). Bare, it lists what is
                                   outstanding and exits non-zero if the tree is holding a
                                   mutation right now. "end" verifies the restore against
                                   the sha256 taken by "begin" and keeps the marker if it
                                   does not match.
  relay "<goal>" [--advisor codex] [--implementer claude]
                 [--implementers "claude --model opus-5, claude --model sonnet-5"]
                 [--reviewer claude] [--reviewer-args "..."]
                 [--rounds N] [--settle SECONDS]
                 [--checks "npm test"] [--checks-informational "..."]
                 [--checks-unrelated "..."] [--advisor-args "..."] [--implementer-args "..."]
                 [--salvage SECONDS] [--json] [--resume <log>] [--record <path>] [--dry-run]
                 [--force]
                 [--max-turns N] [--max-minutes N] [--max-queue-depth N]
                 [--max-concurrent-seats N] [--strict-goal] [--operator agent]
                 [--bypass [agent]] [--detach] [--turn-timeout SECONDS]
                 [--silence-timeout SECONDS]
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
                                   --implementers is the seat LIST, one entry per seat:
                                   "claude,claude" runs two. An entry may carry that seat's
                                   OWN launch arguments after the agent --
                                   "claude --model opus-5, claude --model sonnet-5" runs two
                                   seats on different models -- which is how seats differ
                                   from each other without a second flag correlated to this
                                   one by position. Per-seat arguments are appended after
                                   --implementer-args, so the seat's own spelling wins.
                                   The first entry is the seat
                                   --implementer names, so naming both differently is
                                   refused rather than reconciled. Seats are named
                                   implementer, implementer-2, ...; more than one gets a git
                                   worktree each and refuses to start on a dirty checkout.
                                   With more than one seat, --checks ALSO run against the
                                   merged tree after every merge including the last. Nothing
                                   else looks at it: git reports conflicts, and per-seat
                                   checks run in one seat's own tree, so every seat can pass
                                   while the tree they produce together fails. A failure
                                   mid-run becomes a repair naming both contributing tasks
                                   rather than blaming a seat; after the final merge there is
                                   no seat left to repair it, so the run ends
                                   integration_failed and exits non-zero. One seat has no
                                   merge, so nothing about it changes.
                                   --reviewer names an opt-in seat that reads a diff and
                                   tree the orchestrator builds from a completed seat's own
                                   worktree -- never that seat's report -- and accepts or
                                   rejects before the merge. A rejection becomes an
                                   automatic repair task for the seat that produced the
                                   work; a second rejection of the same work pauses the run.
                                   Absent by default: no reviewer, no review step at all.
                                   The goal is linted before anything starts: an ask with
                                   nothing observable in it cannot be graded better than
                                   reasoned_but_unverified however well the work goes.
                                   Warnings by default, --strict-goal to refuse.
                                   So is the seating: a seat whose CLI is not installed, or
                                   which names a model its CLI does not have, is refused
                                   before anything is spawned, registered or written, rather
                                   than dying on the first turn as an abnormal exit. Only
                                   the agents this run seats are checked, so a Claude-only
                                   run does not ask you to install Codex.
                                   --bypass writes "permissions": "bypass" into
                                   .conclave/config.json, for this run and future ones.
                                   Name an agent to scope it. The models then run commands
                                   without asking; it is as dangerous as it sounds.
                                   --dry-run resolves everything and starts nothing.
                                   --max-turns / --max-minutes stop a run that is still
                                   going, exit non-zero, and put the intended length into
                                   the record. --max-queue-depth bounds admitted work
                                   waiting for a seat and --max-concurrent-seats bounds
                                   seats working at once; both read the dispatcher at a
                                   turn boundary, and both permit the number they are
                                   given, stopping only above it. Every ceiling is
                                   optional and absent means no limit, so a run given
                                   none is bounded only by --rounds as before.
                                   All four are on session too. Refuses to start outside
                                   a git repository unless --force.
                                   --settle bounds how long a turn's transcript is given to
                                   catch up with the hook that says the turn ended. If it
                                   catches up with NOTHING, --salvage (default 90s) is how
                                   much longer the run waits before treating the report as
                                   lost -- because the alternative is ending the run holding
                                   no account of work already on disk.
                                   --turn-timeout SECONDS bounds one turn, and what that
                                   buys depends on the seat. On Claude and Codex it bounds
                                   what the RUN waits for and nothing more: they already
                                   stop waiting at 45min however busy the turn is, and call
                                   one that has gone QUIET hung after 12min; this replaces
                                   the 45 and leaves the 12 alone. Neither clock reaches the
                                   child. What they produce is a timed_out verdict, and the
                                   seat stays unsendable until you cancel it, the transcript
                                   or a hook shows the turn ended, or the child exits.
                                   Kimi and OpenCode run no deadline unless you set one and
                                   have no silence clock at all, and there the deadline does
                                   end the turn -- they run one process per turn and it is
                                   killed -- so there it is the only thing that ever ends a
                                   hung one.
                                   Output pushes out the QUIET clock only; the whole-turn
                                   one is refreshed by nothing and fires however busy the
                                   turn is. When either fires, the seat's transcript is
                                   read: a turn it shows as finished is corrected to
                                   completed, so a lost end-of-turn signal no longer holds
                                   the run up. A turn still WORKING when the whole-turn
                                   clock lands is not corrected -- its transcript says
                                   in progress, which is not evidence it ended -- and is
                                   reported timed_out. Raise --turn-timeout if your turns
                                   are legitimately longer than that.
                                   --silence-timeout SECONDS moves the QUIET clock -- the 12
                                   minutes above -- and leaves the whole-turn one alone. It is
                                   usually the one you want: a child that stopped working
                                   stopped writing, so silence is what a real hang trips
                                   first, and lowering it shortens the wait a hang costs
                                   without shortening the budget a long BUSY turn gets.
                                   Substantive child output pushes it out; nothing the
                                   adapter says about itself does.
                                   Accepted on every seat, honoured only where the adapter
                                   has such a clock: Kimi and OpenCode have none, and a run
                                   mixing them with Claude or Codex applies it to the seats
                                   that can and reports the others as unsupported rather than
                                   refusing the flag or claiming a deadline that will never
                                   fire. unsupported means a seat that goes quiet forever
                                   produces NO verdict, which is worth reading before you
                                   wait on one.
                                   What each seat ended up on is in the --json report under
                                   deadlines, per participant -- configuredSilenceMs is what
                                   you asked for, null if you asked for nothing, and each
                                   participant's silence block is what that seat resolved to.
                                   Every pause point ENDS the run, because a call that
                                   returns an outcome has nowhere to suspend to.
                                   --detach hands the run to a background process and
                                   prints its session id, so the terminal is free. Follow
                                   it with conclave status and conclave events; its
                                   stdout and stderr go to stdio.log beside them, because
                                   a crash before the relay starts appears nowhere else.
                                   Every run is recorded either way -- detaching changes
                                   who waits for it, not what is written down.
                                   A flag this does not recognise is refused rather than
                                   ignored, and so is a second bare token: the goal is ONE
                                   argument. Put -- before a goal that begins with a dash.
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
  session ["<goal>"] [--advisor codex] [--implementer claude]
                   [--implementers "claude --model opus-5, claude --model sonnet-5"]
                   [--reviewer claude] [--reviewer-args "..."]
                   [--rounds N]
                   [--checks "npm test"] [--checks-informational "..."]
                   [--checks-unrelated "..."] [--advisor-args "..."] [--implementer-args "..."]
                   [--bypass [agent]] [--operator agent] [--settle SECONDS]
                   [--salvage SECONDS] [--record <path>] [--resume <log>] [--force]
                   [--turn-timeout SECONDS] [--silence-timeout SECONDS]
                   [--max-turns N] [--max-minutes N]
                   [--max-queue-depth N] [--max-concurrent-seats N] [--dry-run]
                                   The same session, interactively. The goal is optional:
                                   without one the console waits and the first thing you
                                   type starts the run. Pauses become decision
                                   points you resolve: /continue, /rotate, /abort, or a
                                   line of text addressed to a seat by id, e.g. >advisor,
                                   >implementer, >implementer-2.
                                   Shows participant activity while a turn is running.
                                   A flag this does not recognise is refused rather than
                                   ignored, as in relay -- an invented flag used to be skipped
                                   along with the value after it, which is how
                                   "session --goal-file goal.txt" came to open a console
                                   asking for the goal it had just been handed. A second bare
                                   token is refused too: the goal is ONE argument, and -- says
                                   the token after it is a goal however it begins.
                                   --advisor-args / --implementer-args pass extra launch
                                   arguments, e.g. "-m opencode/kimi-k2.6". Required for
                                   any agent that picks its model per invocation.
                                   --implementers is the seat list, as in relay, including
                                   per-seat launch arguments:
                                   "claude --model opus-5, claude --model sonnet-5".
                                   --reviewer is the same opt-in reviewer seat as relay:
                                   absent by default, reads a diff and tree built by the
                                   orchestrator, never a seat's own report.
                                   --checks are REQUIRED: a replacement that cannot
                                   reproduce one rolls the rotation back.
                                   --checks-informational and --checks-unrelated run and
                                   are reported, but never block a transfer -- for checks
                                   that do not exercise the transferred work.
                                   --checks enables rotation; without it a degraded
                                   implementer escalates rather than rotating unverified.
                                   With more than one seat they also run against the MERGED
                                   tree after every merge, as in relay: a clean merge is not
                                   a correct merge.
                                   --operator agent as in relay. Prefer THIS command for an
                                   agent driver: a pause here is held open as a decision
                                   point, where relay ends the run at every one of them.
                                   Commands arrive on stdin as lines, and conclave status
                                   reports the pause with its evidence and options as data,
                                   so nothing has to be scraped off the console.
                                   Refuses to start outside a git repository unless --force,
                                   as relay does: attribution and rotation both diff the
                                   tree, and so does undo. More than one seat additionally
                                   gets a git worktree each and refuses to start on a dirty
                                   checkout, naming what is in the way -- the seats branch
                                   from the integration tree, so uncommitted work in it is
                                   a base nobody can reproduce. One seat has no worktree
                                   and no such refusal.
                                   A seat whose CLI is not installed, or which names a model
                                   its CLI does not have, is refused before anything is
                                   spawned, registered or written -- and only the agents this
                                   run seats are checked.
                                   Every message is recorded to .conclave/runs/ as it
                                   happens, and --resume replays that log into both seats.
                                   Prefer resuming HERE rather than into relay: a resumed
                                   run that hits a pause is held open for you, where relay
                                   would end again at the first one.
                                   --settle / --salvage / --turn-timeout as in relay.
                                   --silence-timeout as in relay: it moves the 12-minute
                                   QUIET clock rather than the whole-turn one, applies to
                                   the seats whose adapter runs it, and reports the rest
                                   as unsupported instead of refusing.
                                   --max-turns / --max-minutes / --max-queue-depth /
                                   --max-concurrent-seats as in relay. Worth setting when
                                   driving with --operator agent: nobody is watching that
                                   run, and without a ceiling nothing but --rounds bounds
                                   it. Absent means no limit, as before.
                                   --record tees every byte written to the terminal,
                                   escape codes included, so a rendering fault can be
                                   inspected rather than screenshotted.
                                   --dry-run resolves everything and starts nothing, as in
                                   relay, and prints the same plan line for line. It stops
                                   above the session lock, so it registers no hooks, probes
                                   no Codex trust, writes no permission mode, takes no lock
                                   and creates no participant. Without a goal the plan says
                                   the goal would be asked for. Refused with --bypass:
                                   applying it would leave a permission mode written by an
                                   invocation that started nothing, and skipping it would
                                   print launch arguments the real run would not use.
`

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
 * Every flag `relay` reads a VALUE for, and every flag `session` does.
 *
 * Two lists rather than one, and they are meant to be read side by side: the difference between
 * them IS the divergence between the front-ends, expressed as data instead of as two blocks of
 * parsing that have to be compared by eye. Today it is one entry (`--detached-id`, which is how
 * a detached child adopts the id its parent printed and has nothing to say to a console), and
 * `frontEndParity.test.ts` fails on any other difference that is not declared there.
 *
 * Boolean flags are absent from THESE lists by design. `--json`, `--force`, `--detach`,
 * `--dry-run` and `--strict-goal` are read with `includes`, take no value, and are
 * legitimately followed by another flag -- putting one here would turn `--force --json` into
 * a missing value. They are declared beside these lists instead, in `RELAY_BOOLEAN_FLAGS` and
 * `SESSION_BOOLEAN_FLAGS`: a switch this file did not know about was indistinguishable from
 * an invented flag, which is why an invented one used to be ignored (#172).
 *
 * Declared rather than derived from the call sites, because the missing-value check runs over
 * the whole argv BEFORE the first read (see `flagReader`), and a check that only knew about
 * flags something had already read could not refuse before the command started work.
 */
const RELAY_VALUED_FLAGS: readonly string[] = [
  'advisor',
  'advisor-args',
  'checks',
  'checks-informational',
  'checks-unrelated',
  'detached-id',
  'implementer',
  'implementer-args',
  'implementers',
  'lead',
  'lead-args',
  'max-concurrent-seats',
  'max-minutes',
  'max-queue-depth',
  'max-turns',
  'operator',
  'record',
  'resume',
  'reviewer',
  'reviewer-args',
  'rounds',
  'salvage',
  'settle',
  'silence-timeout',
  'turn-timeout',
]

const SESSION_VALUED_FLAGS: readonly string[] = RELAY_VALUED_FLAGS.filter((f) => f !== 'detached-id')

/**
 * Every SWITCH each command takes -- the flags that are complete on their own.
 *
 * Declared for the reason the valued ones are, and #172 is what the gap cost. A parser that
 * knew only which flags take values could not tell a switch it accepts from a flag nobody
 * wrote, so it had to ignore both: `session --goal-file /tmp/goal.txt` was parsed, dropped,
 * and started a console asking for the goal that was sitting in the file it had been handed.
 * With both halves declared, an unrecognised flag is a refusal that names the flag.
 *
 * `--help` and `-h` are absent on purpose: they are answered above the dispatch, for every
 * command, and never reach a command's own surface.
 *
 * The difference between the two lists is divergence, exactly as it is for the valued ones,
 * and `frontEndParity.test.ts` fails on any difference that is not declared there.
 */
const RELAY_BOOLEAN_FLAGS: readonly string[] = [
  'bypass',
  'detach',
  'dry-run',
  'force',
  'json',
  'strict-goal',
]

const SESSION_BOOLEAN_FLAGS: readonly string[] = ['bypass', 'dry-run', 'force']

/**
 * What each command accepts, as one value.
 *
 * This is the runtime source of truth: the same object is what values are consumed against,
 * what an invented flag is refused against, and what a near-miss suggestion is drawn from. A
 * flag read by code but missing from here is refused before that code runs, which is what
 * makes the declaration true rather than merely written down.
 */
const RELAY_SURFACE: FlagSurface = {
  valued: RELAY_VALUED_FLAGS,
  boolean: RELAY_BOOLEAN_FLAGS,
  // `--bypass [agent]`, and only the agents that can be scoped. See `FlagSurface`.
  optionalValues: { bypass: CONFIGURABLE_AGENTS },
}

const SESSION_SURFACE: FlagSurface = {
  valued: SESSION_VALUED_FLAGS,
  boolean: SESSION_BOOLEAN_FLAGS,
  optionalValues: { bypass: CONFIGURABLE_AGENTS },
}

/**
 * Read by `frontEndParity.test.ts`, which compares the two surfaces as data.
 *
 * The ONE export, rather than a valued list beside a boolean one. Every question either block
 * asks about its argv is answered from here, so a flag read by code and missing from this
 * object is refused before that code runs -- which is what makes the declaration true rather
 * than merely written down, and what the parity guard checks in both directions.
 */
export const FLAG_SURFACE = { relay: RELAY_SURFACE, session: SESSION_SURFACE } as const

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

/**
 * Injected for testing. Production passes nothing and builds the default registry.
 *
 * The console has had this seam since it was written -- `SessionOptions.registry`, "injected
 * for testing" -- and `relay` had none, so the participants the unattended front-end actually
 * constructs were reachable from no test at all. What stood in for one was a test that read
 * THIS FILE as text and matched an `id:` out of it (#55), which passes whether or not the
 * call it parsed is the call that runs.
 */
export interface MainOverrides {
  /**
   * Replaces `defaultRegistry()` for BOTH front-ends.
   *
   * It reached `relay` only, which left the `session` block below in exactly the position
   * `relay` was in before this seam existed: the participants the console CLI constructs
   * were reachable from no test, and what stood in for one was a regex over this file
   * (#69). `runSession` has had `SessionOptions.registry` all along -- the console tests
   * called it directly and skipped the argv parsing, which is the half that breaks.
   */
  registry?: AgentRegistry
  /**
   * The console's streams. Production passes nothing and the session attaches to the
   * process's own; see `SessionOptions.input`/`output`.
   *
   * Required for the registry override to be usable here at all: an in-process
   * `main(['session', ...])` with no streams draws a live console over the test
   * reporter's stdout and reads its stdin.
   */
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

export async function main(argv: string[], overrides: MainOverrides = {}): Promise<number> {
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
  // Scanned up to `--`, which is where the options end and the positionals begin: a goal is
  // one argv entry, and `conclave session -- "--help"` is an operator saying that entry is
  // their goal. Before the marker the guard is what it was.
  if (beforeEndOfOptions(argv).some((a) => a === '--help' || a === '-h')) {
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
    // A seat worktree declines the question rather than answering it red. Registrations are
    // generated and git-ignored, so git never checks them out into a seat -- a check there
    // reports the RUN ROOT's files as missing for every seat, always, with no bug behind it.
    // Seats run the suite at their own HEAD, so answering `drift` here would land as a seat
    // test failure that no change could fix. Exit zero, say `not_applicable`, and name the
    // root where the question does apply.
    const seat = seatWorktreeAt(resolveRepoRoot())
    if (seat) {
      const declined = notApplicableInSeatWorktree(seat)
      console.log(
        rest.includes('--json') ? formatCheckNotApplicableJson(declined) : formatCheckNotApplicable(declined),
      )
      return 0
    }
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

  if (command === 'notify') {
    // The operating agent's entry point. It calls this when it judges the human is needed --
    // conclave does not decide that, because the operating agent is what has the context (#184).
    const root = process.cwd()
    const verb = sub && !sub.startsWith('--') ? sub : ''
    const flagOf = (name: string): string | undefined => {
      const at = rest.indexOf(`--${name}`)
      return at >= 0 ? rest[at + 1] : undefined
    }

    if (verb === 'vetoes') {
      const transportName = flagOf('transport') ?? 'fake'
      const transport = resolveTransport(transportName)
      if (!transport) {
        console.error(`conclave: no transport named ${transportName} — have: ${transportNames().join(', ')}`)
        return 2
      }
      const taken = await new Broker(root).collectVetoes(transport)
      if (taken.length === 0) {
        console.log('no late answers')
        return 0
      }
      for (const v of taken) console.log(`${v.option ?? JSON.stringify(v.text)}  ← ${v.headline}`)
      // Non-zero: a veto is the operator asking for something to stop, and a caller that
      // ignored it because the command succeeded would be the whole failure this exists to
      // prevent.
      return 1
    }

    if (verb === 'log') {
      const decisions = new Broker(root).decisions()
      if (rest.includes('--json')) {
        console.log(JSON.stringify(decisions, null, 2))
        return 0
      }
      if (decisions.length === 0) {
        console.log('no decisions recorded')
        return 0
      }
      for (const d of decisions) {
        const when = new Date(d.at).toISOString().slice(11, 19)
        // "unanswered" is wrong for a `tell`: nothing asked it anything. The three states are
        // answered, not delivered, and delivered-with-nothing-expected -- and conflating the
        // last two would make a working notification look like a failed question.
        const answered = d.answer
          ? `${d.answer.option ?? JSON.stringify(d.answer.text)} (${d.answer.by.kind} ${d.answer.by.id})`
          : d.undelivered !== undefined
            ? d.undelivered
            : d.offered !== undefined
              ? 'unanswered'
              : 'delivered'
        console.log(`${when}  ${d.kind.padEnd(9)} ${d.headline}`)
        console.log(`          via ${d.transport} — ${answered}`)
      }
      return 0
    }

    if (verb !== 'tell' && verb !== 'ask') {
      console.error('usage: conclave notify tell|ask "<headline>" [--options id:Label,...] [--transport name]')
      console.error('       conclave notify vetoes [--transport name]   late answers to a decision')
      console.error(`       conclave notify log [--json]`)
      console.error(`  transports: ${transportNames().join(', ')}`)
      return 2
    }

    const headline = rest.find((a) => !a.startsWith('--') && rest[rest.indexOf(a) - 1]?.startsWith('--') !== true)
    if (headline === undefined || headline === '') {
      console.error(`conclave: notify ${verb} needs a headline`)
      return 2
    }
    const transportName = flagOf('transport') ?? 'fake'
    const transport = resolveTransport(transportName)
    if (!transport) {
      console.error(`conclave: no transport named ${transportName} — have: ${transportNames().join(', ')}`)
      return 2
    }
    // `id:Label` pairs. An action is an id that was OFFERED; free text is a message and is
    // interpreted by the operating agent, never parsed into a command here.
    const options = (flagOf('options') ?? '')
      .split(',')
      .filter(Boolean)
      .map((pair) => {
        const [id, ...label] = pair.split(':')
        return { id: id!.trim(), label: label.join(':').trim() || id!.trim() }
      })
    const kind = (flagOf('kind') ?? (verb === 'ask' ? 'approval' : 'progress')) as Outbound['kind']
    const message: Outbound = {
      kind,
      headline,
      ...(options.length > 0 ? { options } : {}),
      ...(flagOf('href') ? { href: flagOf('href')! } : {}),
      ...(flagOf('run') ? { runId: flagOf('run')! } : {}),
    }

    const operator = flagOf('operator') === 'human' ? 'human' : 'agent'
    const broker = new Broker(root, { operator })
    if (verb === 'tell') {
      await broker.tell(message, transport)
      // Silent on success by design: a `tell` that printed would make a notification into
      // output the caller has to read, and the caller is an agent with a transcript to spend.
      return 0
    }
    const answer = await broker.ask(message, transport)
    if (!answer) {
      // Non-zero, because the caller asked a question and did not get one answered. The pause
      // or the decision it was asking about has not gone away.
      console.error(`conclave: ${transportName} carried no answer — see conclave notify log`)
      return 1
    }
    console.log(JSON.stringify(answer))
    return 0
  }

  if (command === 'skill') {
    // Offered, never imposed. `install.sh` symlinks one binary and touches nothing else in
    // $HOME; writing into a user's Claude configuration uninvited is a larger change to their
    // environment than installing conclave is, so this is a command they run rather than a
    // step that happens to them (#183).
    const source = join(import.meta.dirname, '..', '.claude', 'skills', 'conclave', 'SKILL.md')
    if (!existsSync(source)) {
      console.error(`conclave: no skill bundled at ${source}`)
      return 1
    }
    const dest = join(process.env.HOME ?? '', '.claude', 'skills', 'conclave')
    if (sub !== 'install') {
      console.log(`conclave: the operator skill is at ${source}`)
      console.log(`  conclave skill install    copy it to ${dest}`)
      console.log('  It teaches an agent operator to start a run, read it, answer a pause and act on how it ended.')
      return 0
    }
    const target = join(dest, 'SKILL.md')
    // An existing skill that differs is somebody's edit, and copying over it would discard
    // work this command has no business deciding about. Identical content is a no-op rather
    // than a refusal, so re-running is safe.
    if (existsSync(target)) {
      const same = readFileSync(target, 'utf8') === readFileSync(source, 'utf8')
      if (same) {
        console.log(`conclave: skill already installed at ${target}`)
        return 0
      }
      if (!rest.includes('--force')) {
        console.error(`conclave: ${target} exists and differs — pass --force to replace it`)
        return 1
      }
    }
    mkdirSync(dest, { recursive: true })
    writeFileSync(target, readFileSync(source, 'utf8'))
    console.log(`conclave: installed the operator skill at ${target}`)
    return 0
  }

  if (command === 'mutations') {
    // Deliberately read-mostly. Detecting an orphan is the whole value (#181); `restore` is
    // here because a report saying "this file is broken" without saying what it was is a
    // puzzle rather than a fix, and the copy that answers that is already on disk.
    const root = process.cwd()
    const action = sub && !sub.startsWith('--') ? sub : 'list'
    if (action === 'begin' || action === 'end' || action === 'restore') {
      const target = rest.find((a) => !a.startsWith('--'))
      if (!target) {
        console.error(`conclave: mutations ${action} needs a path`)
        return 1
      }
      if (action === 'begin') {
        const noteAt = rest.indexOf('--note')
        const note = noteAt >= 0 ? rest[noteAt + 1] : undefined
        const m = beginMutation(root, target, { ...(note === undefined ? {} : { note }) })
        console.log(`conclave: recorded ${m.path} as mutated (sha256 ${m.sha256.slice(0, 12)})`)
        return 0
      }
      if (action === 'restore') {
        const ok = restoreMutation(root, target)
        console.log(ok ? `conclave: restored ${target} from its stored original` : `conclave: no marker for ${target}`)
        return ok ? 0 : 1
      }
      const r = endMutation(root, target)
      if (r.restored) {
        console.log(`conclave: ${target} is back to its original; marker cleared`)
        return 0
      }
      // Non-zero and loud. A restore the caller believed in and got wrong is exactly the
      // state this command exists to catch, and clearing the marker would hide it.
      console.error(
        `conclave: ${target} is NOT back to its original — marker kept\n` +
          `  expected sha256 ${r.expected.slice(0, 12)}, found ${r.actual.slice(0, 12) || '(missing)'}\n` +
          `  \`conclave mutations restore ${target}\` puts the stored original back`,
      )
      return 1
    }
    const all = outstandingMutations(root)
    if (all.length === 0) {
      console.log('no mutations are recorded')
      return 0
    }
    for (const m of all) {
      const state = m.dirty ? 'MUTATED — not restored' : 'restored, stale marker'
      console.log(`${m.marker.path}  [${state}]  pid ${m.marker.pid}${m.marker.note ? `  — ${m.marker.note}` : ''}`)
    }
    // Non-zero only for a tree actually holding a defect. A stale marker is untidy, not a
    // reason for a commit helper to stop.
    return all.some((m) => m.dirty) ? 1 : 0
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
    // The whole argv is understood BEFORE any of it is used, against the surface this command
    // declares. Three refusals come out of that one pass -- a flag whose value went missing, a
    // flag that does not exist, and the goal -- and each names the token that has to change
    // rather than the consequence of it.
    const tail = argv.slice(1)
    // Over the options only. `\u2014bypass` matches no flag and would be dropped, which is the
    // dangerous direction; after `--` the operator has said the token is a positional and
    // means it, so a goal may legitimately open with any dash there is.
    if (!rejectUnicodeDashes(beforeEndOfOptions(tail))) return 1
    const parsed = parseArgv(tail, RELAY_SURFACE)
    // The flag tokens and their values, positionals removed. Every `includes` below reads
    // THIS rather than the raw argv, so a goal that spells a flag -- legal only after `--`,
    // where it was quoted deliberately -- can never be read as one.
    const flagArgv = parsed.flags
    // The same reader the console builds, over the same rules. Both commands used to carry a
    // helper of their own and the two disagreed about what a value is (#81); see `flagReader`.
    const flag = flagReader(flagArgv, RELAY_VALUED_FLAGS)
    // Before anything is read, resolved or written, and in the same place on both front-ends.
    // A flag whose value went missing is an invocation that does not mean what was typed, and
    // relay is the command whose runs nobody is watching: reading `--json` as the round count
    // and starting anyway is a run that has to be found and killed rather than retyped.
    if (flag.missing !== undefined) {
      console.error(missingValueMessage(flag.missing, 'relay'))
      return 1
    }
    // A flag nobody declared used to be skipped, taking its value with it (#172). An argv
    // that does not mean what was typed must not start a run -- least of all this one, whose
    // runs nobody is watching.
    //
    // BELOW the missing-value refusal, and both commands do it in this order. `--rounds
    // --json` leaves `--json` unconsumed, so on `session` -- which has no `--json` -- the
    // same argv is both a value that went missing and a flag that does not exist. Naming the
    // missing value first is the reading that holds on BOTH front-ends, and the two saying
    // different things about one argv is the divergence this pair of blocks exists to prevent.
    if (parsed.unknown.length > 0) {
      console.error(unknownFlagMessage(parsed.unknown, 'relay', RELAY_SURFACE))
      return 1
    }
    // The goal is the bare token, wherever it sits. It was `argv[1]` and nothing else, which
    // read `relay --json "<goal>"` as a run with no goal at all; now that every flag's value
    // is consumed by the scan, a token nothing consumed is the goal and nothing else can be.
    const [goal, ...spare] = parsed.positionals
    if (goal === undefined) {
      console.error('relay needs a goal: conclave relay "<goal>"\n')
      return 1
    }
    // Refused rather than dropped. A second bare token is a goal that lost its quotes or a
    // value whose flag went missing, and starting a run on the half of it that parsed is how
    // an operator finds out an hour later that they briefed the wrong thing.
    if (spare.length > 0) {
      console.error(extraPositionalMessage(spare[0]!, 'relay'))
      return 1
    }
    // Parsed early so this run sees its own flag; written later, once it is going to start.
    const bypass = bypassRequest(flagArgv)
    // ONE reading, hoisted above both the registry and the seat plan because both now depend
    // on it (#89). Read twice, a file edited in between would give the seat list one set of
    // roles and the registry another, and the run would seat a role it could not resolve.
    const projectConfig = withBypass(readProjectConfig(process.cwd()), bypass)
    const registry = overrides.registry ?? defaultRegistry(rolesWithDefined(projectConfig.roles))
    // Everything a human would read goes to STDERR under --json, so stdout carries the
    // report and nothing else. A consumer that had to strip log lines out of a JSON stream
    // is a consumer that will eventually strip the wrong one.
    const asJson = flagArgv.includes('--json')
    const say = (line: string) => (asJson ? console.error(line) : console.log(line))
    // `--advisor`, because that is the word every other surface uses: the seat id, the
    // routing log, the console's `>advisor`, and the briefing itself. `--lead` was the
    // RelayOptions FIELD name leaking into the CLI, and it is kept as an alias so existing
    // scripts do not break.
    const lead = flag('advisor', '') || flag('lead', 'codex')
    // `--implementers` is the seat LIST and `--implementer` is its first entry, so the two are
    // read together by one shared builder rather than separately here. A run given neither
    // passes no `implementers` key at all -- see SeatPlan; the default run must not acquire a
    // seat list it did not ask for (D1).
    const seatPlan = implementerSeatPlan({
      implementer: flag('implementer', 'claude'),
      implementers: flag('implementers', ''),
      implementerNamed: flagArgv.includes('--implementer'),
      // Both only when roles exist, so a run that defines none is refused exactly as it was
      // before roles did: by the registry preflight, saying `unknown agent`. An operator with
      // no roles who mistypes an agent should not be told about a feature they do not use.
      //
      // The registry ACTUALLY in use, not the builtin list: an injected registry seats agents
      // `CONFIGURABLE_AGENTS` has never heard of, and refusing those would refuse a seat this
      // invocation can genuinely fill.
      ...(projectConfig.roles
        ? { roles: projectConfig.roles, knownAgents: registry.list().map((a) => a.id) }
        : {}),
    })
    if (seatPlan.kind === 'refused') {
      console.error(`conclave: ${seatPlan.reason}`)
      return 1
    }
    // One entry per seat, agent and per-seat launch arguments together. A run that named no
    // list is the one seat `--implementer` names, carrying no arguments of its own -- the
    // `--implementer-args` it may have been given applies to every seat and is composed below.
    const seatRequests: SeatRequest[] =
      seatPlan.kind === 'listed' ? seatPlan.seats : [{ agent: flag('implementer', 'claude'), args: [] }]
    const implementerAgents = seatRequests.map((s) => s.agent)
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
    const build = version()

    // What stops this run, resolved ONCE and this early on purpose. Three things below need
    // the same answer -- the launch line, the status the detached parent writes for a child
    // that does not exist yet, and `Relay.start` itself -- and #119 is precisely a run whose
    // operator was told nothing about a bound they believed they had raised. Two of those
    // three sit above the point the old inline resolution was reachable from, so hoisting it
    // is what makes "the report and the run cannot disagree" true rather than nearly true.
    //
    // Built by `ceilingsFrom` and `boundOf`, the shared readers, so this command and `session`
    // cannot differ about what a ceiling flag means. The `flag()` calls stay in this block:
    // the pinned flag sets read it, and a flag parsed out of their sight leaves the guarded
    // surface without anyone deciding to remove it.
    const ceilings = ceilingsFrom({
      maxTurns: flag('max-turns', ''),
      maxMinutes: flag('max-minutes', ''),
      maxQueueDepth: flag('max-queue-depth', ''),
      maxConcurrentSeats: flag('max-concurrent-seats', ''),
    })
    // Read once, because two things consult it: the launch preamble, which is suppressed when
    // the plan is about to say the same lines, and the short-circuit that prints the plan.
    // Spelled as an `includes` over `flagArgv` because that is the form `frontEndParity.test.ts`
    // scans for -- a flag read in a shape the guard cannot see is a flag that quietly leaves
    // the compared surface.
    const isDryRun = flagArgv.includes('--dry-run')
    const runCeilings = effectiveCeilings({
      advisorTurns: boundOf({ maxAdvisorTurns: Number(flag('rounds', '4')) }),
      ...(ceilings ? { ceilings } : {}),
    })

    // Before anything is spawned, registered or written. The failure being guarded is an
    // operator who did not intend to start a run at all, and every line of setup below is
    // work done on their behalf in a directory they did not mean to be in.
    const refusals = preflightRefusals(process.cwd(), { force: flagArgv.includes('--force') })
    for (const r of refusals) console.error(`conclave: ${r.reason}\n  ${r.remedy}`)
    if (refusals.length > 0) return 1

    // Said, not refused. Between the floor and the warning band there is no way to know
    // whether this run will fit, and a guard that stopped every run it was unsure about would
    // be routed around within a week -- the same reasoning as `lintGoal` below.
    for (const w of preflightWarnings(process.cwd())) console.error(`conclave: ${w.reason}\n  ${w.remedy}`)

    // Warned about before anything starts, refused only if asked. A bad goal is sometimes a
    // deliberate probe, and a check that blocks work becomes a check people route around.
    const goalFindings = lintGoal(goal)
    if (goalFindings.length > 0) {
      for (const line of formatGoalFindings(goalFindings)) console.error(line)
      if (flagArgv.includes('--strict-goal')) {
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
    if (flagArgv.includes('--detach') && flagArgv.includes('--dry-run')) {
      console.error(
        'conclave: --detach and --dry-run contradict each other. A dry run resolves ' +
          'everything and starts nothing, so there is no run to hand to a background ' +
          'process. Drop one.',
      )
      return 1
    }
    if (flagArgv.includes('--detach')) {
      const id = newSessionId(runStartedAt, process.pid)
      const root = projectRootFor(process.cwd())
      const dir = sessionDir(root, id)
      mkdirSync(dir, { recursive: true })
      const logFile = join(dir, 'stdio.log')
      const fd = openSync(logFile, 'a')
      // `--` before the goal, always: the child parses this argv exactly as an operator's
      // would be parsed, and a goal beginning with a dash -- legal here because the parent
      // accepted it after a marker of its own -- would otherwise reach the child as a flag.
      const argvOut = [
        'relay',
        ...flagArgv.filter((a) => a !== '--detach'),
        '--detached-id',
        id,
        '--',
        goal,
      ]
      const child = spawn(process.execPath, [process.argv[1]!, ...argvOut], {
        cwd: process.cwd(),
        detached: true,
        stdio: ['ignore', fd, fd],
      })
      // Unreferenced AND detached: without both, this process waits for a child it has
      // deliberately stopped owning, which is the opposite of detaching.
      child.unref()
      closeSync(fd)
      // Through `reportedTargeting`, not a fourth hand-written block.
      //
      // This document is a THIRD serializer of the same rule -- the run report and the recorder
      // are the other two -- and it is the one an agent operator polls first, in the window
      // before the child records itself. A rule about when a key exists, written out three
      // times, is a rule that gets relaxed in two places and kept in the third. So the counters
      // are zeroed here (a child that has not started has taken no advisor turn) and the
      // question of whether the key belongs at all is answered by the same function the other
      // two ask, from the seat list this process just parsed and is about to hand the child.
      const placeholderTargeting = reportedTargeting({
        applicable: seatRequests.length > 1,
        seats: seatRequests.length,
        // No turns, so every counter the block carries comes out zero without one being named
        // here. That is the point of the records being the only store: this placeholder cannot
        // fall out of step with the shape a real run writes, because it does not restate it.
        records: [],
      })
      // What each seat will be measured against, from the argv this process just parsed and is
      // about to hand the child verbatim -- through the same `resolveDeadlines` and the same
      // registry the child itself will use, so the placeholder cannot describe a policy the
      // run will not be under. Seat ids come from `implementerSpecsFor`, the same builder the
      // real specs are built with below, so the ids in this document are the ids the child
      // records. Launch arguments are irrelevant to a deadline and are not composed here.
      const placeholderDeadlines = (() => {
        try {
          return resolveDeadlines({
            ...(flag('turn-timeout', '') ? { requestedAbsoluteMs: Number(flag('turn-timeout', '')) * 1000 } : {}),
            ...(flag('silence-timeout', '')
              ? { requestedSilenceMs: Number(flag('silence-timeout', '')) * 1000 }
              : {}),
            seats: [
              { id: 'advisor', agent: lead },
              ...implementerSpecsFor(seatRequests, () => []).map((sp) => ({ id: sp.id, agent: sp.agent })),
              ...(flag('reviewer', '') ? [{ id: 'reviewer', agent: flag('reviewer', '') }] : []),
            ].map((seat) => ({ ...seat, declared: registry.get(seat.agent).deadlines })),
          })
        } catch {
          return undefined
        }
      })()

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
        build,
        // Resolved here rather than left for the child, and it is the one field on this
        // placeholder that is not a placeholder. `participants: []` is honestly empty -- nobody
        // has joined -- but the ceilings are known NOW, from the argv this process just parsed
        // and is about to hand the child verbatim. A detached run is the form an agent operator
        // uses, `status --json` is the only interface it has, and the window before the child
        // records itself is exactly when it polls. Omitting the block there would make the fix
        // absent at the moment it is most needed, and worse, a run whose child dies during
        // startup keeps this document forever -- so this is the ONLY report those runs get.
        ceilings: runCeilings,
        // Resolved here too, for the reason `ceilings` above is: this document is the ONLY
        // report a detached run whose child dies during startup ever produces, and the window
        // before the child records itself is exactly when an agent operator polls. A
        // `deadlines` block that appeared only once the relay was up would be missing at the
        // moment it is most needed -- and on this front-end, permanently.
        //
        // Wrapped, and omitted rather than thrown on failure. The seat specs are not VALIDATED
        // until further down (`registry.resolve`), so an argv naming an unknown agent reaches
        // here first, and `registry.get` would throw -- turning a run the child refuses with
        // the registry's own sentence into a parent-side stack trace, on a path that used to
        // detach cleanly. Omitting the block leaves the document exactly as it was before this
        // existed, which is what the field's optionality already means, and the child writes
        // the real one moments later on every run that is going to start at all.
        ...(placeholderDeadlines ? { deadlines: placeholderDeadlines } : {}),
        // Empty, and honestly so: a child that has not started has rotated nothing. Written
        // here for the same reason `ceilings` is -- the key has to exist at the moment an agent
        // operator polls, or a probe reading it gets a falsy value it cannot tell from a build
        // that does not report rotation intent at all (#103, #75). Appended last, so it lands
        // where the recorder's own document puts it.
        rotations: [],
        // Zeroed, and honestly so: a child that has not started has taken no advisor turn. Written
        // here for the reason `ceilings` and `rotations` are -- an agent operator polls in exactly
        // the window before the child records itself, and on a run whose child dies during startup
        // this placeholder is the only report they ever get (#79).
        //
        // And absent entirely on a one-seat run, which is the same rule the recorder applies and
        // is applied here rather than left for the child so the document does not change shape
        // when the child takes over. See `placeholderTargeting` above for why that rule is asked
        // of `reportedTargeting` rather than restated here.
        ...(placeholderTargeting ? { targeting: placeholderTargeting } : {}),
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

    // Config-derived args first, then per-invocation ones, so an explicit flag wins.
    const leadArgs = [...launchArgsFor(projectConfig, lead), ...extraArgs(flag('advisor-args', '') || flag('lead-args', ''))]
    // Per AGENT, not per seat: `.conclave/config.json` keys launch arguments by agent, and two
    // seats can be filled by different ones. `--implementer-args` is the operator's own addition
    // and applies to every implementer seat, because there is one flag and it says implementer.
    // Arguments for ONE seat ride inside its `--implementers` entry instead, and are appended
    // after these by `implementerSpecsFor` so the more specific spelling is the one that wins.
    const implArgsFor = (agent: string) => [
      ...launchArgsFor(projectConfig, agent),
      ...extraArgs(flag('implementer-args', '')),
    ]
    const implSpecs = implementerSpecsFor(seatRequests, implArgsFor)
    // Opt-in and singular (#72). Absent when `--reviewer` was not given -- `reviewerSpecFor`
    // returns `undefined`, and no `reviewer` key reaches `Relay.start` at all.
    const reviewerSpec = reviewerSpecFor(flag('reviewer', ''), (agent) => [
      ...launchArgsFor(projectConfig, agent),
      ...extraArgs(flag('reviewer-args', '')),
    ])
    // Every seat's argv is read back off its spec rather than recomposed for the plan, so the
    // dry run cannot print something the real run does not match -- which is the one thing a
    // dry run must not do. See the plan built below.
    const allAgents = [lead, ...implementerAgents, ...(reviewerSpec ? [reviewerSpec.agent] : [])]
    const bypassing = allAgents.filter((a) => permissionModeFor(projectConfig, a) === 'bypass')
    if (bypassing.length > 0) {
      say(`  permission prompts bypassed for ${[...new Set(bypassing)].join(', ')} — per ${CONFIG_RELATIVE}`)
    }

    // Every seat resolved before anything is written, so a dry run answers the argv on its own
    // merits and a plan is only ever printed for a run that could actually happen (#136). A
    // plan naming a seat no registry can fill is the dry run failing at its only job, and the
    // operator would find out when they dropped the flag -- which is exactly the moment the
    // flag exists to come before. `session` has refused this since #130; relay is what moved.
    //
    // It THROWS rather than writing its own refusal, so the operator gets the registry's own
    // sentence -- `unknown agent 'nope'. Registered agents: ...` -- the same one relay produced
    // before, just without hooks, the trust probe and the run log happening first.
    //
    // `leadSpec` is hoisted so the object validated here is the object handed to `Relay.start`
    // below; the seat checked and the seat launched cannot drift.
    const leadSpec = { id: 'advisor', agent: lead, role: 'advisor' as const, ...(leadArgs.length > 0 ? { args: leadArgs } : {}) }
    for (const spec of [leadSpec, ...implSpecs, ...(reviewerSpec ? [reviewerSpec] : [])]) {
      registry.resolve(spec)
    }

    // The existence question only, and it belongs above the dry run for the reason #130 put
    // it above the console's lock: a path that is not there will not become there because the
    // command was about to start something, so refusing it is an answer to the argv alone.
    const resumeFrom = flag('resume', '')
    if (resumeFrom && !runLogExists(resumeFrom)) {
      console.error(`conclave: no run log at ${resumeFrom}`)
      return 1
    }

    // What stops this run, above the rotation line rather than after it, because these are the
    // lines that describe the LAUNCH and rotation is the last of them -- the same order the
    // console banner reads in. #119 is a relay that ended at an advisor budget of 8, the
    // default, while `--max-turns 40` sat in its argv bounding something else and left 488
    // uncommitted insertions that survived only because a human was watching. The flag typed
    // was valid and the flag meant was absent, so nothing anywhere could have said so. This
    // line could have, before any work existed to lose.
    //
    // NOT PRINTED ON A DRY RUN, and neither are the two deadline lines below it. The plan
    // prints the same three, from the same objects, through the renderer both front-ends
    // share -- so a relay dry run that printed the preamble too would say each of them twice,
    // three lines apart, in slightly different column alignment. Which is worse than noise: an
    // operator comparing two near-identical blocks has to check whether they agree, and the
    // answer is that they cannot disagree, which is exactly what the reader cannot tell by
    // looking. The console has never had the duplicate -- `runSession` returns above its
    // banner -- so suppressing here is also what makes the two commands' dry runs read alike.
    //
    // A REAL LAUNCH KEEPS THEM. It prints no plan, so these lines are the only place any of it
    // appears, and they are the reading #119 is about: told before there is work to lose.
    if (!isDryRun) say(`  ceilings: ${ceilingSummary(runCeilings)}`)

    // Beside the ceilings line, above rotation, for the reason the ceilings line gives: these
    // are the lines that describe the LAUNCH, and a policy an operator is told about before
    // any work exists is one they can still change for free. What these add that the ceilings
    // line cannot is the per-seat word `unsupported` -- a seat whose adapter runs no clock
    // produces NO verdict when that clock's condition is met, and an operator who assumed
    // otherwise waits on a timeout that is not coming.
    //
    // BOTH clocks, absolute first. Only silence was printed here at first, on the grounds that
    // `--turn-timeout` had been reportable since it shipped; it was reportable in the run
    // report and in `status --json`, which are documents of a run that already exists, and
    // there is nothing to change for free by the time either is written.
    //
    // Resolved by `resolveDeadlines` from the specs this command just validated, through the
    // same registry and the same precedence `Relay.deadlines` uses -- so the line printed here
    // and the block in the run report cannot be two different answers.
    //
    // Bound to a const rather than resolved inline, because the dry-run plan below needs the
    // SAME answer and a second `resolveDeadlines` call beside it would be two resolutions of
    // one run -- the exact failure `dryRunPlan.ts` exists to prevent, reintroduced one level
    // above the module that prevents it. `runCeilings` is hoisted for the same reason four
    // hundred lines up.
    const runDeadlines = resolveDeadlines({
      ...(flag('turn-timeout', '') ? { requestedAbsoluteMs: Number(flag('turn-timeout', '')) * 1000 } : {}),
      ...(flag('silence-timeout', '')
        ? { requestedSilenceMs: Number(flag('silence-timeout', '')) * 1000 }
        : {}),
      seats: [leadSpec, ...implSpecs, ...(reviewerSpec ? [reviewerSpec] : [])].map((spec) => ({
        id: spec.id,
        agent: spec.agent,
        declared: registry.get(spec.agent).deadlines,
      })),
    })
    // Suppressed on a dry run with the ceilings line above, and for the reason given there.
    // The RESOLUTION is not suppressed -- `runDeadlines` is built either way, because the plan
    // is handed this object rather than resolving its own.
    if (!isDryRun) {
      say(`  turn:     ${absoluteSummary(runDeadlines)}`)
      say(`  silence:  ${silenceSummary(runDeadlines)}`)
    }

    say(
      checks.length > 0
        ? `  rotation armed — a degraded implementer will be replaced, verified by: ${checks.map((c) => (typeof c === 'string' ? c : `${c.command} [${c.relevance}]`)).join(', ')}`
        : '  rotation NOT armed — no --checks, so degradation escalates instead of rotating',
    )

    if (isDryRun) {
      // Everything above this line is resolution: config read, checks parsed, args composed.
      // Nothing below it is, so this is the last point at which nothing has been spawned.
      //
      // Respects --json for the same reason the report does: an agent operator checking what
      // WOULD run is exactly the caller most likely to be parsing, and handing it prose
      // because it also passed --dry-run would be the trap this mode exists to avoid.
      //
      // Built and rendered by `dryRunPlan` / `dryRunPlanLines`, which the console's own dry run
      // also calls. The two commands compose their launch arguments in different places -- here,
      // and inside `runSession` from the config it reads itself -- so the ONE thing that must
      // not be written twice is the description of the result. See `dryRunPlan.ts`.
      const plan: DryRunPlanInput = {
        cwd: process.cwd(),
        goal,
        advisor: { agent: lead, args: leadArgs },
        implementers: implSpecs.map((s) => ({ id: s.id, agent: s.agent, args: s.args ?? [] })),
        seatsNamed: seatPlan.kind === 'listed',
        // Opt-in and absent otherwise (#72): a default dry run's document does not gain a
        // `reviewer` key it never had a reason to carry.
        ...(reviewerSpec ? { reviewer: { agent: reviewerSpec.agent, args: reviewerSpec.args ?? [] } } : {}),
        checks,
        // The same two objects the launch lines above were printed from, and the same ones
        // `Relay.start` is handed below -- not a re-resolution for the plan. A dry run's whole
        // claim is that the plan is the run, and a plan that resolved its own ceilings would be
        // making that claim about numbers nothing else in this block had seen.
        ceilings: runCeilings,
        deadlines: runDeadlines,
      }
      if (asJson) {
        console.log(JSON.stringify(dryRunPlan(plan), null, 2))
      } else {
        for (const line of dryRunPlanLines(plan)) say(line)
      }
      return 0
    }

    // Register before starting, as the console does. `relay` refused at the preflight in a
    // project that had never run Conclave — correctly, but with an instruction where an
    // action belonged, and inconsistently with the other front-end. Registration is a
    // precondition for the tool to work at all, not a decision; what IS a decision is
    // editing someone's .gitignore, which is why the un-ignored paths are reported instead.
    const registered = await installConfig({
      projectRoot: process.cwd(),
      agents: [...new Set(allAgents)].filter((a): a is AgentKind =>
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
      agents: [...new Set(allAgents)].filter((a): a is AgentKind =>
        (AGENT_KINDS as string[]).includes(a),
      ),
      say,
      // Appended rather than redrawn: this is the unattended form, its output is usually a
      // file, and a spinner in a log is noise. It still says something, because a silent
      // minute waiting on a Codex TUI is indistinguishable from a hang.
      slow: async (label, detail, work) => {
        say(`  ${label} · ${detail}`)
        return work()
      },
    })

    // AFTER installation and the trust probe, and the ordering is the point rather than an
    // accident of the diff. `--bypass` WRITES a permission mode into the project for this run
    // and every future one, and the two calls above are the ones most likely to fail on a
    // machine that has never run this. Applying the mode first would leave that setting behind
    // on a run that then refused to start -- a consequential change from an invocation that
    // reported doing nothing, which is #136's own complaint one line further down.
    //
    // No longer conditional: the dry run returns above, so `!flagArgv.includes('--dry-run')` would
    // guard a state that cannot be reached, and a redundant guard is one nobody maintains.
    if (!applyBypassFlag(flagArgv, say)) return 1

    // Recorded continuously into a gitignored directory, because a record written on exit
    // is exactly the record a crash destroys -- and a crash is one of the endings a resume
    // exists for. Named for when the run started, so a directory listing is chronological.
    const recordPath =
      flag('record', '') || join(process.cwd(), '.conclave', 'runs', `relay-${runStartedAt}.ndjson`)
    const recorder = new RunLogWriter(recordPath)

    // READING it is a different thing from asking whether it is there, and it happens on this
    // side of the line with the rest of the work a real run does.
    const prior = resumeFrom ? readRunLog(resumeFrom) : []
    if (prior.length > 0) {
      say(`  resuming from ${resumeFrom} — ${prior.length} messages replayed into both seats`)
    }

    const relay = await Relay.start({
      registry,
      cwd: process.cwd(),
      ...(prior.length > 0 ? { resume: prior } : {}),
      ...(flag('operator', '') === 'agent' ? { operator: 'agent' as const } : {}),
      lead: leadSpec,
      // `implSpecs[0]` IS the seat this used to build by hand: `seatIdFor(0)` is 'implementer'
      // and the args are the same list, so a default invocation hands `Relay.start` the object
      // it always did. The plural key is spread in only when the operator named a seat list.
      implementer: implSpecs[0]!,
      ...(seatPlan.kind === 'listed' ? { implementers: implSpecs } : {}),
      ...(reviewerSpec ? { reviewer: reviewerSpec } : {}),
    // Descriptions only: prose is the whole of what the relay uses a role for (#89). Absent
    // when no role is defined, which keeps the briefing byte-identical on a default run.
    ...(projectConfig.roles ? { roleDescriptions: Object.fromEntries(Object.entries(projectConfig.roles).map(([n, r]) => [n, r.description])) } : {}),
      maxAdvisorTurns: runCeilings.advisorTurns,
      // Built by `ceilingsFrom` rather than inline, so this command and `session` cannot
      // disagree about what a ceiling flag means. Read where the launch line above is printed,
      // for the stronger version of the same rule: the run and the report of the run must come
      // from one resolution, not two that happen to match.
      ...(ceilings ? { ceilings } : {}),
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
      // Seconds in, milliseconds out, as the console does it. The deadline for a turn that
      // has gone SILENT (#36) was adjustable only from the front-end with a human sitting
      // in front of it -- and the unattended one is where forty-five minutes of silence
      // costs the most, because nobody is there to notice it and stop the run by hand.
      ...(flag('turn-timeout', '')
        ? { turnWatchdogMs: Number(flag('turn-timeout', '')) * 1000 }
        : {}),
      // The OTHER clock, and the one a hang actually trips. --turn-timeout bounds the whole
      // turn; this bounds how long it may say nothing, which is the reading #36 was about --
      // a turn that took a tool result and went quiet, waited out at the absolute cap because
      // silence had no flag of its own. Accepted on any run, including one seating an adapter
      // that runs no silence clock: refusing would throw away a setting the other seats can
      // honour, and `Relay.deadlines` reports the unsupported seats as `unsupported` rather
      // than as enforcing a number they will never fire.
      ...(flag('silence-timeout', '')
        ? { silenceWatchdogMs: Number(flag('silence-timeout', '')) * 1000 }
        : {}),
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
      build,
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
        console.log(JSON.stringify(await runReport(relay, { goal, outcome, startedAt: runStartedAt, build }), null, 2))
      }
      say(`\n=== relay ended: ${outcome.reason}${outcome.detail ? ` — ${outcome.detail}` : ''}`)
      // `integration_failed` joins the two endings that already exit non-zero: the run
      // finished and left a tree that does not pass its own checks (#80). An unattended
      // caller — CI, a wrapper script, an agent operator — decides on the exit code, and a
      // zero there is the whole failure the issue is about, one layer out.
      // `peer_busy` joins them for the same reason: the run stopped without finishing, and an
      // unattended caller deciding on the exit code must not read "a child stayed busy" as
      // success. It is the ending that used to arrive here as `transport_failed` (#117), and
      // the exit code it produced then is the one it must keep producing now.
      // `invariant_violated` joins them by the same argument, and with the least room for
      // doubt: it used to arrive here AS `transport_failed` (#74), so the exit code it produced
      // then is the one it must keep producing now. A run that stopped because Conclave
      // contradicted itself is the last ending that should read as success to a wrapper script.
      failed =
        outcome.reason === 'transport_failed' ||
        outcome.reason === 'peer_busy' ||
        outcome.reason === 'invariant_violated' ||
        outcome.reason === 'ceiling' ||
        outcome.reason === 'integration_failed'
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
      // What `--checks` actually reached (#153). Undefined -- and so unprinted -- when nothing
      // was configured, because the rotation line above already covers that case.
      const integration = relay.integrationSummary()
      if (integration !== undefined) say(`=== ${integration}`)
      // Only when there was a second seat to address (#79). `targetingSummary` returns undefined
      // on a one-seat run rather than a line saying there is nothing to say: the advisor there was
      // never given the syntax and could not have used it, and a line that is noise on the common
      // run is a line an operator learns to skip past on the run where it means something.
      const targeting = relay.targetingSummary()
      if (targeting !== undefined) say(`=== ${targeting}`)
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
    // The same three refusals as `relay`, in the same order, out of the same one pass over
    // the argv -- see the relay block above. What differs is the goal, and only the goal:
    // here it is optional, because without one the console comes up and waits and the first
    // thing typed starts the run.
    const tail = argv.slice(1)
    if (!rejectUnicodeDashes(beforeEndOfOptions(tail))) return 1
    const parsed = parseArgv(tail, SESSION_SURFACE)
    // The flag tokens and their values. Read by every `includes` below, so a goal quoted
    // after `--` is never mistaken for the flag it spells.
    const flagArgv = parsed.flags
    // The same reader `relay` builds, over the same rules. The console's own helper refused
    // every value beginning with `--`, including the ones that are argv for a child CLI, so
    // `--implementer-args "--model x"` was refused here and launched there (#81).
    const flag = flagReader(flagArgv, SESSION_VALUED_FLAGS)
    // Refused BEFORE the bypass is applied, as the seat-plan contradiction below is and for the
    // same reason: an invocation that is not going to start a session must not leave a
    // permission mode written into the operator's project on its way out. It used to be checked
    // after, which it could not help being -- `bad` was only known once every read had happened.
    if (flag.missing !== undefined) {
      console.error(missingValueMessage(flag.missing, 'session'))
      return 1
    }
    // `session --goal-file /tmp/goal.txt` is the invocation this refuses, and #172 is what it
    // used to do: the flag matched nothing, so it was skipped, the path after it was skipped
    // with it, and the console opened asking for the goal it had just been handed. Nothing was
    // printed either, because the stray-token warning this replaces exempted a token that
    // followed a flag -- and the flag it followed was one nobody had ever declared.
    //
    // Below the missing-value refusal, in the same order as `relay`; see the note there.
    if (parsed.unknown.length > 0) {
      console.error(unknownFlagMessage(parsed.unknown, 'session', SESSION_SURFACE))
      return 1
    }
    // Wherever it sits, and there is at most one. A goal written after a flag used to be
    // dropped with a warning that the console was starting anyway -- which reads, to the
    // operator watching an empty prompt, as the console having ignored their sentence. Every
    // flag's value is consumed by the scan, so a bare token is a goal and a SECOND bare token
    // is something nothing is going to use: refused, rather than started around.
    const [goal, ...spare] = parsed.positionals
    if (spare.length > 0) {
      console.error(extraPositionalMessage(spare[0]!, 'session'))
      return 1
    }
    const checks = parseChecks(
      flag('checks', ''),
      flag('checks-informational', ''),
      flag('checks-unrelated', ''),
    )
    const lead = flag('advisor', '') || flag('lead', 'codex')
    // Both front-ends, together, through the same builder. See the relay block above: this is
    // the ninth capability that would otherwise have been wired into one command and not the
    // other, and the seat count is not one an operator should have to discover empirically.
    //
    // The console reads the rest of the config layer inside `startSession`, so only the roles
    // are read here -- the seat list has to resolve BEFORE the session is constructed, and a
    // name that is neither a role nor an agent must be refused while an operator is still
    // looking at the terminal (#89).
    const sessionRoles = readProjectConfig(process.cwd()).roles
    const seatPlan = implementerSeatPlan({
      implementer: flag('implementer', 'claude'),
      implementers: flag('implementers', ''),
      implementerNamed: flagArgv.includes('--implementer'),
      ...(sessionRoles
        ? { roles: sessionRoles, knownAgents: (overrides.registry ?? defaultRegistry()).list().map((a) => a.id) }
        : {}),
    })
    const seatRequests: SeatRequest[] =
      seatPlan.kind === 'listed' ? seatPlan.seats : [{ agent: flag('implementer', 'claude'), args: [] }]
    const implementerAgents = seatRequests.map((s) => s.agent)
    const implementer = implementerAgents[0]!
    const rounds = flag('rounds', '8')
    // The same flag `relay` has. Its absence here is what made an agent pick the front-end
    // that cannot hold a pause -- see SessionOptions.operator.
    const operator = flag('operator', '') === 'agent' ? ('agent' as const) : undefined
    const force = flagArgv.includes('--force')
    // All three existed on `relay` and were unreachable here. `--record` is the starkest:
    // `SessionOptions.record` is documented as the way to inspect a rendering fault in the
    // bytes rather than from a screenshot, and no invocation could switch it on.
    const settle = flag('settle', '')
    const salvage = flag('salvage', '')
    const record = flag('record', '')
    const resume = flag('resume', '')
    const turnTimeout = flag('turn-timeout', '')
    const silenceTimeout = flag('silence-timeout', '')
    // Ceilings, console-side for the first time. `--operator agent` already makes this an
    // unattended run, and an unattended run with no ceiling of any kind is the live gap this
    // closes -- not a provision for N>1. Same builder as `relay`, so the two cannot drift.
    const ceilings = ceilingsFrom({
      maxTurns: flag('max-turns', ''),
      maxMinutes: flag('max-minutes', ''),
      maxQueueDepth: flag('max-queue-depth', ''),
      maxConcurrentSeats: flag('max-concurrent-seats', ''),
    })
    const leadArgs = extraArgs(flag('advisor-args', '') || flag('lead-args', ''))
    const implementerArgs = extraArgs(flag('implementer-args', ''))
    const reviewer = flag('reviewer', '')
    const reviewerArgs = extraArgs(flag('reviewer-args', ''))
    // Both front-ends, together. Wiring a capability into one and not the other is the
    // mistake this codebase has now made six times.
    // Refused BEFORE the bypass is applied, which is this block's point of no return: an
    // invocation that is not going to start a session must not leave a permission mode written
    // into the operator's project on its way out.
    if (seatPlan.kind === 'refused') {
      console.error(`conclave: ${seatPlan.reason}`)
      return 1
    }
    /**
     * `--dry-run` and `--bypass` are refused TOGETHER rather than resolved either way.
     *
     * Both orderings are wrong, which is what makes this a refusal instead of a decision:
     *
     *   - APPLY the bypass and the dry run has written a permission mode into the operator's
     *     project, for this run and every future one, from an invocation whose own last line
     *     says nothing was started. That is the failure `applyBypassFlag`'s position in this
     *     block exists to prevent, arrived at from the other side.
     *   - SKIP it and the plan is a plan of a run that would launch with different launch
     *     arguments than the ones printed -- `--dangerously-skip-permissions` is composed from
     *     the config, and the config is what the bypass would have changed. A dry run whose
     *     argv is not the plan's argv is the one thing this mode must never produce.
     *
     * `relay` has a third option and takes it: `withBypass` overlays the requested mode onto
     * the config IN MEMORY, so its plan is composed as the run would be while nothing is
     * written. The console has no such overlay -- `runSession` reads the project config itself,
     * which is the whole reason the plan is printed there (#130) -- so the honest answer here
     * is to say the two flags do not go together rather than to pick a side quietly.
     *
     * Read through `bypassRequest` rather than by scanning the argv for the flag here: the
     * parity guard compares the flags each block MENTIONS, and the bypass token appearing in
     * this block and not in relay's would read as a capability the console has and relay lacks.
     */
    const dryRun = flagArgv.includes('--dry-run')
    if (dryRun && bypassRequest(flagArgv).requested) {
      console.error(
        'conclave: --dry-run and --bypass contradict each other. --bypass WRITES a permission ' +
          'mode into .conclave/config.json for this run and future ones, and a dry run must ' +
          'leave nothing behind; skipping the write would print launch arguments the real run ' +
          'would not use. Run the dry run first, then --bypass without it.',
      )
      return 1
    }
    // The console applies and persists together: there is no in-memory overlay as in `relay`,
    // so the point of no return is here. A dry run never reaches it -- it is refused above with
    // `--bypass`, and without one there is nothing to apply.
    if (!applyBypassFlag(flagArgv, (l) => console.log(l))) return 1
    return runSession({
      cwd: process.cwd(),
      ...(operator ? { operator } : {}),
      ...(force ? { force } : {}),
      // Absent unless asked for, so a normal console run passes exactly the options it always
      // passed. `runSession` prints the plan and returns above its lock check -- see `dryRun`
      // on SessionOptions for why it cannot be printed from here.
      ...(dryRun ? { dryRun } : {}),
      ...(settle ? { transcriptSettleMs: Number(settle) * 1000 } : {}),
      ...(salvage ? { transcriptSalvageMs: Number(salvage) * 1000 } : {}),
      ...(record ? { record } : {}),
      ...(resume ? { resume } : {}),
      ...(goal === undefined ? {} : { goal }),
      lead,
      implementer,
      // Seat REQUESTS rather than specs: `runSession` owns seat construction, and handing it a
      // spec list would put `seatIdFor` on both sides of the wire. What crosses is what the
      // operator asked for -- an agent and that seat's own launch arguments -- which is the
      // smallest thing that cannot lose the pairing on the way. Absent unless the operator named
      // a list, so a default console run passes exactly the options it always passed.
      ...(seatPlan.kind === 'listed' ? { implementers: seatPlan.seats } : {}),
      rounds: Number(rounds),
      checks,
      ...(leadArgs.length > 0 ? { leadArgs } : {}),
      ...(implementerArgs.length > 0 ? { implementerArgs } : {}),
      ...(reviewer ? { reviewer } : {}),
      ...(reviewerArgs.length > 0 ? { reviewerArgs } : {}),
      version: version(),
      ...(turnTimeout ? { turnWatchdogMs: Number(turnTimeout) * 1000 } : {}),
      ...(silenceTimeout ? { silenceWatchdogMs: Number(silenceTimeout) * 1000 } : {}),
      ...(ceilings ? { ceilings } : {}),
      // Testing seams, and nothing production passes. Wiring one into `relay` and not here
      // is the mistake this codebase keeps making, and this time it made the console CLI
      // itself untestable rather than a flag unreachable.
      //
      // Assigned rather than conditionally spread, which is why the three fields are
      // declared `| undefined` on SessionOptions: a spread is not excess-property checked,
      // so `{ registy: ... }` inside one compiles and drops the seam without a word. These
      // keys are now the compiler's problem rather than a reviewer's.
      registry: overrides.registry,
      input: overrides.input,
      output: overrides.output,
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

/**
 * Only when this file IS the program.
 *
 * `main` is exported so the default-run guard can drive the real `relay` command instead of
 * reading this file as text. Without this check, importing it would run the importer's argv
 * as a command -- under `node --test` that is a file path, so every test file would try to
 * start a session and exit the process.
 *
 * Through realpath on both sides because an npm-installed `conclave` is a symlink into this
 * file, and comparing the link to its target would take the CLI out of service entirely.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => exitAfterFlush(code),
    (err) => {
      console.error(`conclave: ${err instanceof Error ? err.message : String(err)}`)
      return exitAfterFlush(1)
    },
  )
}
