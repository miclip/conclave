/**
 * How many seconds a hook handler is given before the CLI kills it.
 *
 * Ten is generous for a POST to localhost and tight for a cold `node` start on a saturated
 * machine — normally ~40ms, and observed to exceed ten seconds when every core was pinned. The
 * handler is then killed before it runs at all, which is indistinguishable from hooks that were
 * never registered unless you know to look for the absence of an attempts journal (#41).
 *
 * Configurable rather than raised, because the right value is a property of the machine rather
 * than of conclave. Raising the default would make every genuine hook failure take longer to
 * report, which is a cost paid by everyone to help the loaded case.
 */
export function hookTimeoutSeconds(): number {
  const raw = process.env['CONCLAVE_HOOK_TIMEOUT_S']
  if (raw === undefined) return 10
  const n = Number(raw)
  // A malformed value falls back rather than throwing at registration time: a bad env var must
  // not be the reason a session cannot start, and 10 is the value it would have had anyway.
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10
}
