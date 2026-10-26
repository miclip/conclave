/**
 * `readKimiConfig` run in a child of its own, so a test can see what it writes to the
 * PROCESS's stderr. Not named `*.test.ts`, so `npm test` never collects it;
 * `kimiConfig.test.ts` spawns it with the config path as its one argument.
 *
 * #389: a `python3` child run by `execFileSync` with default stdio has its stderr copied to fd 2
 * of whoever called `readKimiConfig`, as well as captured on the error. Inside the test process
 * that is invisible -- it lands in the runner's own output, not in anything an assertion can
 * read -- so the call has to happen one process further away, with that process's stderr piped
 * back separately.
 *
 * stdout carries one JSON line: what the function returned, or the message it threw, which is
 * what conclave would go on to print. stderr carries only what leaked.
 */

import { readKimiConfig } from './kimiConfig.ts'

const path = process.argv[2]
if (!path) {
  process.stderr.write('usage: kimiConfig.fixture.ts <config path>\n')
  process.exit(2)
}

try {
  process.stdout.write(JSON.stringify({ value: readKimiConfig(path) }) + '\n')
} catch (err) {
  process.stdout.write(
    JSON.stringify({ name: (err as Error).name, message: err instanceof Error ? err.message : String(err) }) + '\n',
  )
}
