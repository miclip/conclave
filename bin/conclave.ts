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
  launchArgsFor,
  permissionModeFor,
  readProjectConfig,
  setPermissionMode,
} from '../src/config/project.ts'
import { formatConfigShow, formatConfigShowJson, showConfig } from '../src/config/show.ts'
import type { CheckSpec } from '../src/rotation/record.ts'
import { runReport } from '../src/relay/report.ts'
import { RunLogWriter, readRunLog, runLogExists } from '../src/relay/resume.ts'
import { preflightRefusals } from '../src/relay/guardrails.ts'
import { formatGoalFindings, lintGoal } from '../src/relay/goalLint.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedCodexTrust } from '../src/deployment/codexHookTrust.ts'
import { defaultRegistry } from '../src/registry/builtin.ts'
import { runSession } from '../src/repl/session.ts'
import { Relay } from '../src/relay/relay.ts'
import { formatGuardReportJson, guard } from '../src/workspace/sessionLock.ts'

const USAGE = `conclave <command>

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
                 [--json] [--resume <log>] [--record <path>] [--dry-run] [--force]
                 [--max-turns N] [--max-minutes N] [--strict-goal] [--operator agent]
                 [--bypass [agent]]
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
                                   Every pause point ENDS the run, because a call that
                                   returns an outcome has nowhere to suspend to.
                                   Spawns real sessions and uses real quota.
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
                   [--bypass [agent]]
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
`

/**
 * The version in the banner, read from package.json.
 *
 * A release ships one archive per platform and they are otherwise indistinguishable, so a
 * session has to be able to say which build produced it. Read rather than compiled in,
 * because there is no build step to compile it in at.
 */
function version(): string {
  try {
    return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
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
function applyBypassFlag(args: string[], say: (line: string) => void): boolean {
  const i = args.indexOf('--bypass')
  if (i < 0) return true
  // An agent name may follow. Anything flag-shaped is the next option, not an argument.
  const next = args[i + 1]
  const agent = next && !next.startsWith('--') ? next : undefined

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

async function main(argv: string[]): Promise<number> {
  const [command, sub, ...rest] = argv

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

  if (command === 'relay') {
    const goal = sub
    // A flag in the goal position is FLAGS, not a goal named `--help`. `session` has
    // guarded this since it was written; `relay` never did, so `conclave relay --help`
    // launched two real agent sessions, asked an advisor what `--help` means, and billed
    // for it. The one invocation someone types when they do not know what a command does
    // was the one that spent their quota.
    if (!goal || goal.startsWith('-')) {
      if (goal === '--help' || goal === '-h') {
        console.log(USAGE)
        return 0
      }
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
    // Before the config is read, so this run sees what it just wrote.
    if (!applyBypassFlag(rest, say)) return 1

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

    const projectConfig = readProjectConfig(process.cwd())
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
    let failed = false
    // Before the run, not after the relay is built: a report whose duration excluded startup
    // would understate how long the operator actually waited.
    try {
      const outcome = await relay.run(goal)
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
    }
    return failed ? 1 : 0
  }

  if (command === 'session') {
    // The goal is optional: without one the console comes up and waits, and the first
    // thing typed starts the run. So a flag in the first position is not a goal named
    // `--lead` — it is a session with no goal and some flags, which is legitimate.
    const args = [sub, ...rest].filter((a): a is string => a !== undefined)
    const goal = args[0] && !args[0].startsWith('--') ? args[0] : undefined
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
    const turnTimeout = flag('turn-timeout', '')
    const leadArgs = extraArgs(flag('advisor-args', '') || flag('lead-args', ''))
    const implementerArgs = extraArgs(flag('implementer-args', ''))
    // Both front-ends, together. Wiring a capability into one and not the other is the
    // mistake this codebase has now made six times.
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
