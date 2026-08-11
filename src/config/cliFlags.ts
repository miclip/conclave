/**
 * One flag reader, shared by both front-ends.
 *
 * `relay` and `session` each parsed their own argv with a helper of their own, and the two did
 * not agree on what a VALUE is. Relay took whatever token followed the flag. The console read a
 * token beginning with `--` as a value that had gone missing, and said so. So:
 *
 *   relay   --implementer-args "--model x"   launched the implementer with --model x
 *   session --implementer-args "--model x"   refused: "--implementer-args was given without a value"
 *
 * The flag exists on both commands, which is why the parity guard was satisfied by it (#81):
 * that guard compared which flags EXIST, and the divergence lived entirely in the parsing. It is
 * the eleventh capability found differing between the front-ends and the first where the flag
 * itself was present on both, so the fix is not another flag wired into another block — it is
 * one reader, with one answer, that neither command can restate differently.
 *
 * The console's rule was the better half and is kept: `--rounds --json` is a flag whose value
 * went missing, and reading `--json` as the number of rounds is worse than refusing. What was
 * wrong is that the rule was applied to flags whose value is deliberately an argv fragment for
 * ANOTHER cli, where a leading `--` is the normal spelling of a value. Those are named in
 * `PASS_THROUGH_FLAGS` and exempted, and every other flag is now checked on both commands.
 *
 * Validated eagerly, over the whole argv, at construction. Lazily -- only for flags that happen
 * to be read -- each command could refuse only at a point after all of its own reads, and the
 * two commands read in different orders and stop at different places. A reader that knows the
 * whole answer before the first read lets both refuse in the same place, which is the property
 * that makes them comparable.
 */

/**
 * Flags whose value is an argv fragment handed to a child CLI.
 *
 * `--implementer-args "--model claude-opus-5"` is one flag with one value, and that value is
 * two tokens of somebody else's command line. A leading `--` there is a value, not a value that
 * went missing, and refusing it is what made per-seat model selection -- the mechanism behind
 * heterogeneous seats (#77) -- unreachable from the console front-end.
 *
 * The cost, which is real and is the reason this list is short rather than a permission: after
 * a pass-through flag, ONE token is consumed whatever it looks like. `--implementer-args
 * --advisor-args` reads `--advisor-args` as the implementer's launch argument, because at that
 * point there is nothing left to distinguish the two readings. Quoting is the operator's half
 * of that bargain, and the flags on this list are the ones where the bargain is worth making.
 */
export const PASS_THROUGH_FLAGS: readonly string[] = ['advisor-args', 'lead-args', 'implementer-args']

export interface FlagReader {
  /** The value given for `--name`, or `fallback` when it was not given. */
  (name: string, fallback: string): string
  /**
   * The first flag in the argv that was typed without a value, or `undefined` when every
   * declared flag has one. Computed once, over the whole argv, so it is complete before the
   * first read rather than accumulating as reads happen.
   */
  readonly missing: string | undefined
}

/**
 * Read `argv` for the valued flags a command declares.
 *
 * `valued` is the command's whole valued-flag surface, and it is required rather than inferred
 * because the scan cannot tell `--force` (a boolean, followed by the next flag) from `--rounds`
 * (a value that went missing) without being told which is which. Declaring it has a second
 * effect worth as much as the first: the two commands' surfaces become two lists that can be
 * compared as data, instead of two blocks of code that have to be read.
 *
 * Reading a flag the command did not declare THROWS. That is a programming error rather than an
 * operator error -- the flag would be parsed by a rule nobody chose -- and it fails on the first
 * invocation of the command rather than on the first invocation that happens to pass it.
 */
export function flagReader(argv: readonly string[], valued: readonly string[]): FlagReader {
  const declared = new Set(valued)
  const passThrough = new Set(PASS_THROUGH_FLAGS)
  const found = new Map<string, string>()
  let missing: string | undefined

  // One left-to-right scan, consuming each flag's value as it goes. The consumption is the
  // part an `indexOf` cannot do: `--implementer-args --rounds` passes `--rounds` to the child,
  // and a later `indexOf('--rounds')` would find that VALUE and read the token after it as the
  // round count. First occurrence wins, which is what both helpers did before this one.
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    if (!declared.has(name)) continue
    const value = argv[i + 1]
    if (value === undefined || (value.startsWith('--') && !passThrough.has(name))) {
      missing ??= name
      continue
    }
    if (!found.has(name)) found.set(name, value)
    i++
  }

  const read = (name: string, fallback: string): string => {
    if (!declared.has(name)) {
      throw new Error(
        `--${name} is read here but is not one of this command's valued flags. Add it to the ` +
          `list passed to flagReader: an undeclared flag is one the missing-value check cannot ` +
          `see, which is how the two front-ends came to disagree about values in the first place.`,
      )
    }
    return found.get(name) ?? fallback
  }

  return Object.defineProperty(read, 'missing', { value: missing, enumerable: true }) as FlagReader
}

/**
 * What to print when a flag was typed without a value.
 *
 * Shared for the same reason the reader is: an operator who hits this on one command and then
 * the other should be told the same thing about the same argv.
 *
 * The npm paragraph is not shared, and that is the one place the two messages differ on
 * purpose. `npm run session` is a real script in this package and `npm run relay` is not, so
 * mangled quoting is a live explanation on one command and a wrong guess on the other -- and a
 * wrong first suggestion costs more than no suggestion when the operator is already confused
 * about which token went where.
 */
export function missingValueMessage(name: string, command: 'relay' | 'session'): string {
  const npmAdvice =
    command === 'session'
      ? `If you used \`npm run session -- ...\`, npm mangles quoted arguments containing\n` +
        `spaces. Call the binary directly instead:\n\n`
      : ''
  return (
    `--${name} was given without a value.\n\n` +
    npmAdvice +
    `  node bin/conclave.ts ${command} "<goal>" --checks "npm test"\n`
  )
}
