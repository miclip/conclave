#!/usr/bin/env node
/**
 * Conclave CLI. Currently one subcommand; the shape is here so `config install` does not
 * end up as an ad-hoc script that only its author knows to run.
 */

import { formatInstallResult, installConfig } from '../src/config/install.ts'

const USAGE = `conclave <command>

Commands:
  config install [--no-diagnose]   Render project-local hook registrations for this
                                   checkout, then report whether Codex will run them.
`

async function main(argv: string[]): Promise<number> {
  const [command, sub, ...rest] = argv

  if (command === 'config' && sub === 'install') {
    const result = await installConfig({ diagnose: !rest.includes('--no-diagnose') })
    console.log(formatInstallResult(result))
    // A checkout needing its first trust decision is not a failure, so this does not
    // exit non-zero on `retrustRequired` alone.
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
