#!/usr/bin/env node
/**
 * Conclave CLI. Currently one subcommand; the shape is here so `config install` does not
 * end up as an ad-hoc script that only its author knows to run.
 */

import {
  formatInstallResult,
  formatInstallResultJson,
  hasDrift,
  installConfig,
} from '../src/config/install.ts'
import { defaultRegistry } from '../src/registry/builtin.ts'
import { Relay } from '../src/relay/relay.ts'
import { guard } from '../src/workspace/sessionLock.ts'

const USAGE = `conclave <command>

Commands:
  config install [--no-diagnose]   Render project-local hook registrations for this
                                   checkout, then report whether Codex will run them.
  config check   [--no-diagnose] [--json]
                                   Report drift without writing. Exits non-zero if the
                                   registrations differ from the templates. Prefer this
                                   before anything that depends on stable Codex trust.
                                   --json prints the report as JSON on stdout instead of
                                   prose; the exit code is unchanged.
  guard                            Report whether participant sessions are live and which
                                   paths changed since they started. Exits non-zero while
                                   live, so it can gate a commit helper.
  relay "<goal>" [--lead codex] [--implementer claude] [--rounds N]
                                   Run a two-agent session: the lead steers, the
                                   implementer works, prose only in both directions.
                                   Spawns real sessions and uses real quota.
`

async function main(argv: string[]): Promise<number> {
  const [command, sub, ...rest] = argv

  if (command === 'config' && sub === 'check') {
    const result = await installConfig({
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
    const result = await installConfig({ diagnose: !rest.includes('--no-diagnose') })
    console.log(formatInstallResult(result))
    // A checkout needing its first trust decision is not a failure, so this does not
    // exit non-zero on `retrustRequired` alone.
    return 0
  }

  if (command === 'guard') {
    const report = guard(process.cwd())
    if (!report.live && !report.stale) {
      console.log('no participant sessions are live')
      return 0
    }
    for (const m of report.messages) console.log(m)
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
    const relay = await Relay.start({
      registry,
      cwd: process.cwd(),
      lead: { id: 'advisor', agent: flag('lead', 'codex'), role: 'advisor' },
      implementer: { id: 'implementer', agent: flag('implementer', 'claude'), role: 'implementer' },
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
