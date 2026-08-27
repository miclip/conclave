/**
 * One flag reader, shared by both front-ends -- and one declared flag SURFACE they are read
 * against.
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
 * itself was present on both, so the fix is not another flag wired into another block -- it is
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
 *
 * #172 is the other half of the same argument, arrived at from the operator's side. A flag
 * nobody declared was not refused; it was IGNORED. `session --goal-file /tmp/goal.txt` parsed
 * cleanly, dropped both tokens on the floor, and opened a console waiting for the goal that was
 * sitting in the file it had been handed -- and the token after the invented flag was exempted
 * from the stray-token warning, so nothing was printed either. An argv that does not mean what
 * was typed must not start a run. So the surface a command accepts is declared as data
 * (`FlagSurface`), the same declaration is what the parser refuses against, what the near-miss
 * suggestion is drawn from, and what `frontEndParity.test.ts` compares -- one list, so a flag
 * cannot be read by code that no check can see.
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

/**
 * Everything a command accepts, as data.
 *
 * Both halves are required, and the boolean half is the one #172 was missing. A parser that
 * knows only the valued flags cannot tell `--force` (a switch it takes) from `--goal-file` (a
 * flag nobody wrote), so it must ignore both -- and ignoring an invented flag is how an
 * invocation comes to mean something other than what was typed.
 *
 * The same declaration serves three purposes on purpose: it is what the scan consumes values
 * against, what an unknown flag is refused against, and what the near-miss suggestion is drawn
 * from. A second list would be a second thing to keep in step, which is the failure this whole
 * file is about.
 */
export interface FlagSurface {
  /** Flags that take the following token as their value. */
  readonly valued: readonly string[]
  /** Flags that take no value. */
  readonly boolean: readonly string[]
  /**
   * Boolean flags that MAY absorb one following token, and the exact tokens they absorb.
   *
   * `--bypass [agent]` is the only one, and the enumeration is the point: accepting any
   * non-flag token after it meant `conclave session --bypass "fix the login bug"` wrote
   * `agents["fix the login bug"]` into the project config and dropped the goal. Listing the
   * tokens keeps the goal a goal.
   */
  readonly optionalValues?: Readonly<Record<string, readonly string[]>>
}

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

/** What one left-to-right pass over an argv knows about it. */
interface Scan {
  values: Map<string, string>
  missing: string | undefined
  flags: string[]
  positionals: string[]
  unknown: string[]
}

/**
 * The one pass. Every question either front-end asks about its argv is answered from here.
 *
 * `surface` is optional, and its absence is what separates the two readings this file supports.
 * Without it the scan knows only which flags take values, so a token it does not recognise is
 * simply not its business -- it consumes nothing and moves on, which is what lets `--force` sit
 * beside `--rounds 4` without being read as a missing value. With it, the scan knows the whole
 * accepted surface, so an unrecognised flag is an invented one and is reported.
 *
 * Two entry points over one loop rather than two loops: `flagReader` and `parseArgv` disagreeing
 * about which token is a value is the exact shape of #81, and code that cannot disagree with
 * itself is cheaper than a test that checks whether it has.
 */
function scanArgv(
  argv: readonly string[],
  valued: readonly string[],
  surface?: FlagSurface,
): Scan {
  const declared = new Set(valued)
  const booleans = new Set(surface?.boolean ?? [])
  const passThrough = new Set(PASS_THROUGH_FLAGS)
  const scan: Scan = { values: new Map(), missing: undefined, flags: [], positionals: [], unknown: [] }

  // One left-to-right scan, consuming each flag's value as it goes. The consumption is the
  // part an `indexOf` cannot do: `--implementer-args --rounds` passes `--rounds` to the child,
  // and a later `indexOf('--rounds')` would find that VALUE and read the token after it as the
  // round count. First occurrence wins, which is what both helpers did before this one.
  let endOfOptions = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!

    // `--` is the end of the options and the beginning of the positionals. It exists for one
    // invocation: a goal that begins with a dash. `conclave session -- "--force is broken"` is
    // a sentence about a flag, not the flag, and before the marker there was no way to say so
    // -- the goal was read as flags and the run started with none.
    if (!endOfOptions && token === '--') {
      endOfOptions = true
      continue
    }
    if (endOfOptions || !token.startsWith('-') || token === '-') {
      scan.positionals.push(token)
      continue
    }

    const name = token.startsWith('--') ? token.slice(2) : token.slice(1)
    if (token.startsWith('--') && declared.has(name)) {
      scan.flags.push(token)
      const value = argv[i + 1]
      if (value === undefined || (value.startsWith('--') && !passThrough.has(name))) {
        scan.missing ??= name
        continue
      }
      if (!scan.values.has(name)) scan.values.set(name, value)
      scan.flags.push(value)
      i++
      continue
    }
    if (surface === undefined) {
      // Not this reader's business: a boolean, or a flag some other check owns. Consuming
      // nothing is what keeps `--force --json` two switches rather than a flag and its value.
      scan.flags.push(token)
      continue
    }
    if (token.startsWith('--') && booleans.has(name)) {
      scan.flags.push(token)
      const next = argv[i + 1]
      const absorbs = surface.optionalValues?.[name]
      if (next !== undefined && absorbs?.includes(next)) {
        scan.flags.push(next)
        i++
      }
      continue
    }
    scan.unknown.push(token)
  }
  return scan
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
  const { values, missing } = scanArgv(argv, valued)

  const read = (name: string, fallback: string): string => {
    if (!declared.has(name)) {
      throw new Error(
        `--${name} is read here but is not one of this command's valued flags. Add it to the ` +
          `list passed to flagReader: an undeclared flag is one the missing-value check cannot ` +
          `see, which is how the two front-ends came to disagree about values in the first place.`,
      )
    }
    return values.get(name) ?? fallback
  }

  return Object.defineProperty(read, 'missing', { value: missing, enumerable: true }) as FlagReader
}

/**
 * The tokens before `--`, which are the ones that were typed as OPTIONS.
 *
 * Two checks want exactly this and neither wants the positionals: the help guard, so a goal
 * spelling `--help` after the marker is a goal rather than a request for the usage text, and
 * the unicode-dash refusal, so `\u2014bypass` is still caught wherever it appears while a goal
 * the operator marked as a positional is left alone. Everything after the marker is a thing
 * somebody said they meant.
 */
export function beforeEndOfOptions(argv: readonly string[]): string[] {
  const marker = argv.indexOf('--')
  return marker < 0 ? [...argv] : argv.slice(0, marker)
}

/** What one argv turned out to be, once the declared surface has been applied to it. */
export interface ParsedArgv {
  /** The flag tokens and the values they consumed, in argv order, positionals removed. */
  readonly flags: string[]
  /** Every token that is not a flag and not a flag's value, in argv order. */
  readonly positionals: string[]
  /** Flag-shaped tokens that are not on the surface. Empty when the argv is understood. */
  readonly unknown: string[]
}

/**
 * Split an argv into the flags a command accepts, its positionals, and what it does not accept.
 *
 * The split is what makes strictness possible in both directions. `flags` is what every later
 * `includes('--x')` in the command block reads, so a goal that happens to spell a flag --
 * legal only after `--` -- can never be mistaken for one. `positionals` is the goal and
 * anything else that was typed beside it, so a token nobody is going to use is refused rather
 * than dropped. `unknown` is the invented flag, named rather than ignored.
 */
export function parseArgv(argv: readonly string[], surface: FlagSurface): ParsedArgv {
  const { flags, positionals, unknown } = scanArgv(argv, surface.valued, surface)
  return { flags, positionals, unknown }
}

/** Edit distance, capped by nothing and needed for words this short. */
function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return rows[a.length]![b.length]!
}

/**
 * The flag on the surface nearest to what was typed, when there is one near enough to name.
 *
 * Drawn from the same declaration the refusal is made against, which is the property worth
 * having: a suggestion computed from a second list would eventually name a flag the parser no
 * longer takes, and a wrong suggestion is worse than none to an operator who is already
 * looking at a refusal.
 */
export function nearestFlag(typed: string, surface: FlagSurface): string | undefined {
  const bare = typed.replace(/^-+/, '').split('=')[0]!
  const all = [...surface.valued, ...surface.boolean]
  let best: { name: string; d: number } | undefined
  for (const name of all) {
    const d = distance(bare, name)
    if (best === undefined || d < best.d) best = { name, d }
  }
  // Two edits on a word of this length is already a stretch; three is a different flag. A
  // one-letter flag name is not close to anything, hence the length floor.
  if (best === undefined || best.d > 2 || best.d >= bare.length) return undefined
  return best.name
}

/**
 * What to print when an argv names a flag the command does not have.
 *
 * The bad flag first, because that is the token to fix. Then the nearest name, when there is
 * one -- a typo is the common case and retyping the whole invocation to find out which letter
 * was wrong is the cost this saves. Then the whole surface, because the second most common
 * case is a flag the operator believed existed, and for that there is nothing to suggest and
 * the answer is the list.
 */
export function unknownFlagMessage(
  unknown: readonly string[],
  command: 'relay' | 'session',
  surface: FlagSurface,
): string {
  const lines: string[] = []
  for (const token of unknown) {
    lines.push(`${command}: ${token} is not a flag this command takes.`)
    // `--rounds=4` parses as a flag named `rounds=4`, which is nobody's typo: it is the other
    // spelling of a value, and saying which spelling this cli uses is the whole answer. Asked
    // first, because the nearest name to `--rounds=4` is `--rounds` and answering "did you
    // mean --rounds?" to somebody who typed --rounds tells them nothing they can act on.
    const base = token.replace(/^-+/, '').split('=')[0]!
    if (token.includes('=') && surface.valued.includes(base)) {
      lines.push(`  a value is a separate token here: --${base} <value>`)
      continue
    }
    const near = nearestFlag(token, surface)
    if (near) lines.push(`  did you mean --${near}?`)
  }
  lines.push('')
  lines.push(`${command} takes:`)
  lines.push(`  with a value: ${surface.valued.map((f) => `--${f}`).join(' ')}`)
  lines.push(`  on their own: ${surface.boolean.map((f) => `--${f}`).join(' ')}`)
  lines.push('')
  lines.push(`  node bin/conclave.ts ${command} "<goal>" --checks "npm test"`)
  return lines.join('\n')
}

/**
 * What to print when the argv carries a token nothing is going to use.
 *
 * The goal is ONE argument. A second bare token is either a goal that lost its quotes or a
 * value whose flag went missing, and both of those are invocations that do not mean what was
 * typed -- the console used to warn about the first and start anyway, which reads to the
 * operator as the console having ignored their sentence.
 */
export function extraPositionalMessage(token: string, command: 'relay' | 'session'): string {
  return (
    `${command}: "${token}" is not being used.\n\n` +
    `The goal is one argument, and it comes first. If this is part of the goal, quote the\n` +
    `whole goal; if it is a flag's value, the flag has to come before it.\n\n` +
    `  node bin/conclave.ts ${command} "<goal>" --checks "npm test"\n`
  )
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
