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
} from '../src/config/project.ts'
import { formatConfigShow, formatConfigShowJson, showConfig } from '../src/config/show.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultRegistry } from '../src/registry/builtin.ts'
import { runSession } from '../src/repl/session.ts'
import { Relay } from '../src/relay/relay.ts'
import { formatGuardReportJson, guard } from '../src/workspace/sessionLock.ts'

const USAGE = `conclave <command>

Commands:
  config install [--claude] [--codex] [--no-diagnose]
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
                                   goes. Reads only — it renders nothing, writes nothing,
                                   creates no directories and does not diagnose Codex
                                   trust, so it is safe to run at any time. Always exits
                                   zero; config check is the one to gate on.
  guard          [--json]          Report whether participant sessions are live and which
                                   paths changed since they started. Exits non-zero while
                                   live, so it can gate a commit helper. --json prints the
                                   report as JSON on stdout instead of prose; the exit
                                   code is unchanged.
  relay "<goal>" [--lead codex] [--implementer claude] [--rounds N]
                                   Run a two-agent session unattended and print the
                                   routing log. Every pause point ENDS the run, because a
                                   call that returns an outcome has nowhere to suspend to.
                                   Spawns real sessions and uses real quota.
  version                          Print the version of this build.
  demo [--record <file>]           Run the console against scripted participants: real
                                   terminal, real readline, no agents and no quota. For
                                   looking at rendering changes in seconds rather than
                                   minutes. --record tees every byte, escape codes
                                   included, so a rendering fault can be inspected rather
                                   than screenshotted.
  session ["<goal>"] [--lead codex] [--implementer claude] [--rounds N]
                   [--checks "npm test"]
                                   The same session, interactively. The goal is optional:
                                   without one the console waits and the first thing you
                                   type starts the run. Pauses become decision
                                   points you resolve: /continue, /rotate, /abort, or a
                                   line of text addressed with @advisor / @implementer.
                                   Shows participant activity while a turn is running.
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

async function main(argv: string[]): Promise<number> {
  const [command, sub, ...rest] = argv

  if (command === 'config' && sub === 'show') {
    // Deliberately not routed through `installConfig`: `show` reports resolution, and a
    // dry-run install would read templates and rendered files to answer a question nobody
    // asked here — then fail on a missing template instead of printing the roots.
    const report = showConfig()
    console.log(rest.includes('--json') ? formatConfigShowJson(report) : formatConfigShow(report))
    // Always zero. There is no failing state to report: the roots resolve or the command
    // throws, and a permission mode is a choice rather than drift.
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
    if (!goal) {
      console.error('relay needs a goal: conclave relay "<goal>"\n')
      return 1
    }
    const flag = (name: string, fallback: string) => {
      const i = rest.indexOf(`--${name}`)
      return i >= 0 ? (rest[i + 1] ?? fallback) : fallback
    }
    const registry = defaultRegistry()
    const lead = flag('lead', 'codex')
    const implementer = flag('implementer', 'claude')

    // `.conclave/config.json` is a property of the PROJECT, not of which front-end opened
    // it. Reading it only in the console meant an unattended run ignored the permission
    // mode the operator had configured — and an unattended run is the one with nobody to
    // answer a prompt it then stops at.
    const projectConfig = readProjectConfig(process.cwd())
    const leadArgs = launchArgsFor(projectConfig, lead)
    const implArgs = launchArgsFor(projectConfig, implementer)
    const bypassing = [lead, implementer].filter((a) => permissionModeFor(projectConfig, a) === 'bypass')
    if (bypassing.length > 0) {
      console.log(`  permission prompts bypassed for ${[...new Set(bypassing)].join(', ')} — per ${CONFIG_RELATIVE}`)
    }

    const relay = await Relay.start({
      registry,
      cwd: process.cwd(),
      lead: { id: 'advisor', agent: lead, role: 'advisor', ...(leadArgs.length > 0 ? { args: leadArgs } : {}) },
      implementer: {
        id: 'implementer',
        agent: implementer,
        role: 'implementer',
        ...(implArgs.length > 0 ? { args: implArgs } : {}),
      },
      maxRounds: Number(flag('rounds', '4')),
      // The routing log is the only complete account of the session, so it is printed as
      // it happens rather than assembled at the end.
      onLog: (m) => {
        if (m.visibility === 'internal') {
          console.log(`  · ${m.text}`)
          return
        }
        const arrow = m.to.length ? `-> ${m.to.join(', ')}` : '-> (recorded only)'
        // Loud only for a genuine restriction. Ordinary point-to-point routing is not
        // hidden influence, and saying so on every line would make the label useless.
        const flag =
          m.visibility === 'restricted' ? `  RESTRICTED — withheld from ${m.excluded.join(', ')}` : ''
        console.log(`\n[${m.seq}] ${m.from} (${m.fromRank}) ${arrow}${flag}`)
        console.log(m.text.trim().split('\n').map((l) => `    ${l}`).join('\n'))
      },
    })
    try {
      const outcome = await relay.run(goal)
      console.log(`\n=== relay ended: ${outcome.reason}${outcome.detail ? ` — ${outcome.detail}` : ''}`)
      console.log(`=== ${relay.log.length} messages routed`)
    } finally {
      await relay.stop()
    }
    return 0
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
    const checks = flag('checks', '').split(',').map((c) => c.trim()).filter(Boolean)
    const lead = flag('lead', 'codex')
    const implementer = flag('implementer', 'claude')
    const rounds = flag('rounds', '8')
    const turnTimeout = flag('turn-timeout', '')
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
