/**
 * The argv for a node child that must run under the flags this process was run under.
 *
 * The launcher starts the CLI as `node --disable-warning=ExperimentalWarning bin/conclave.ts`
 * (#313). A child started from `process.execPath` gets none of that unless it is passed on,
 * so `process.execArgv` goes first, as `child_process.fork` does. Injectable for the tests.
 */
export function nodeArgv(entry: string, args: readonly string[], execArgv: readonly string[] = process.execArgv): string[] {
  return [...execArgv, entry, ...args]
}
