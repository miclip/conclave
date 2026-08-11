/**
 * Whether the model a launch argv names is one the child would accept -- asked of the child.
 *
 * #82: a run was started with `--implementers "claude --model opus-5, claude --model sonnet-5"`.
 * Those aliases do not exist. Both children launched, every turn produced nothing whatsoever, and
 * each died twelve minutes later at the silence deadline with `timed_out (uncertain)`. Twenty-five
 * minutes of run, no work, and nothing anywhere said "that model does not exist".
 *
 * THE MODEL LIST IS NOT IN THIS FILE, and that is the design rather than an omission. A
 * known-good table here would have refused `fable` before `fable` shipped, and a validator that
 * refuses valid input is worse than no validator: the workaround is to switch it off, and then
 * nothing validates anything. The same argument this repository already makes about `RoleId`
 * being `export type RoleId = string` (src/registry/roles.ts:15) applies to a model name, which
 * changes far faster than a role does. So the children are asked, once per run, and what they
 * answer is the whole of what is known.
 *
 * The catch is that they answer to different degrees, which is why this is GRADED rather than
 * boolean. Measured on the installed CLIs while writing this:
 *
 *   opencode models   60 names, one `provider/model` per line. The whole set: absence is a fact.
 *   claude --help     names three aliases inside the `--model` option text and says a full model
 *                     name is also accepted. Half an answer, and the half it gives is the half
 *                     the reported bug is in.
 *   codex models      `Error: stdin is not a terminal`. Cannot be asked at all without a pty.
 *   kimi models       `No such command 'models'`, and its model normally comes from the config
 *                     file the adapter generates rather than from the argv.
 *
 * `unsupported` is the honest grade for the last two, and it is the grade the capability model
 * already has for exactly this: a claim the adapter cannot make. Guessing from a list nobody
 * maintains would be worse than saying so.
 *
 * NOTHING IS ASKED WHEN NOTHING WAS SELECTED. `modelFromArgs` returns `null` for an argv that
 * names no model, and a `null` selection is not checked, has no subprocess spent on it, and is
 * not a finding: the default run does not select a model, so it does not pay for this at all.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentDefinition } from './types.ts'

const run = promisify(execFile)

/**
 * How far an adapter can get towards "the child would accept this model".
 *
 * Four states rather than a boolean, and none of them collapses into another:
 *
 *   enumerated    the CLI lists its models and the list is the whole set, so a name that is
 *                 absent from it is refused.
 *   aliases_only  the CLI names SOME of what it takes and accepts names it never names. Only
 *                 selections the list can judge are judged; the rest pass through.
 *   unsupported   the CLI cannot be asked. A statement about the adapter, like
 *                 `ClockSupport.supported: false` -- no configuration turns it on.
 *   undeclared    this agent definition said nothing. Distinct from `unsupported` on purpose:
 *                 "cannot be asked" is a finding and "nobody wrote it down" is not, and a
 *                 report that showed them the same way would let an unfinished registration
 *                 look like a verified capability gap.
 */
export type ModelValidationGrade = 'enumerated' | 'aliases_only' | 'unsupported' | 'undeclared'

/**
 * How one agent's models are discovered, declared beside its launch spec.
 *
 * Declared per definition rather than worked out from the agent's id where the check runs, for
 * the reason `DeadlineSupport` gives: an id check is a copy of this table that nobody updates,
 * and it lands in whichever module happened to need the answer first.
 */
export interface ModelSupport {
  grade: Exclude<ModelValidationGrade, 'undeclared'>
  /**
   * The subprocess that answers, and what its output means.
   *
   * Required for the two graded-as-checkable states and absent for `unsupported`, which is the
   * type saying what the grade says: there is no command to run.
   */
  ask?:
    | {
        command: string
        args: string[]
        /**
         * The names in that output. An EMPTY result is "the CLI did not answer in a shape this
         * knows", which leaves the selection unchecked -- never refused. A help text that gets
         * reworded must not start rejecting every model an operator names.
         */
        parse: (output: string) => string[]
      }
    | undefined
  /**
   * Which selections the discovered names can judge. Absent means all of them.
   *
   * This is what makes `aliases_only` more than a weaker `enumerated`: claude's help names
   * aliases and says a full model name is also accepted, so `opus-5` is judged against the
   * alias list and `claude-opus-5` is not judged at all.
   */
  judges?: ((model: string) => boolean) | undefined
  /**
   * The selection as the enumeration spells it, when the argv may carry more than the name.
   *
   * `--model sonnet[1m]` selects the `sonnet` alias with a context window attached, and comparing
   * the whole token against a list of bare aliases would refuse a spelling the child accepts.
   */
  normalize?: ((model: string) => string) | undefined
  /** What the discovered names are, in the refusal. Both forms, because 'aliass' is not a word. */
  noun: string
  nounPlural: string
  /** Why the CLI cannot be asked. Required when the grade is `unsupported`. */
  reason?: string | undefined
}

/** One seat's selection, and what could be established about it. */
export interface ModelCheck {
  /** The seat id, so a refusal names which one of several is wrong. */
  participant: string
  agent: string
  /** The model named on the composed argv. `null` selections never reach here. */
  model: string
  grade: ModelValidationGrade
  /** The whole operator-facing refusal, when the selection is refused. */
  refusal?: string | undefined
  /** Why nothing was judged, when nothing was. Never a refusal. */
  unchecked?: string | undefined
}

/** One seat, as much of it as this needs. */
export interface ModelSelection {
  participant: string
  agent: AgentDefinition
  /** From `modelFromArgs`; `null` means the argv selected none and there is nothing to check. */
  model: string | null
}

/**
 * Asking one CLI a question, as a seam.
 *
 * Injectable so a caller can supply an answer without a subprocess -- the `unsupported` grade is
 * proved by asserting this is never called -- while the default below runs a real child, which
 * is what every test that exercises a grade uses.
 */
export interface AskCli {
  (command: string, args: string[]): Promise<string>
}

/**
 * How long a child gets to list its models.
 *
 * Short deliberately. This runs before a run that is about to spend minutes or hours, so the
 * subprocess is cheap in that context -- but a CLI that hangs here would hang the start, and the
 * failure mode of NOT knowing is already handled: an unanswered ask leaves the selection
 * unchecked, which is where this started.
 */
export const ASK_TIMEOUT_MS = 20_000

const defaultAsk: AskCli = async (command, args) => {
  // Both streams, because a CLI may answer on either: `opencode models` writes its list to
  // stdout, and a help text is stdout on the CLIs here but is stderr on plenty of others.
  // Reading one and calling the silence an answer is how a parse comes back empty for a CLI
  // that answered perfectly well.
  //
  // stdio is pipes, so the child has no terminal. That is deliberate and it is the condition
  // `codex models` fails on -- which is the measurement behind its `unsupported` grade rather
  // than an accident of how this happens to spawn.
  const { stdout, stderr } = await run(command, args, {
    timeout: ASK_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  })
  return `${stdout}\n${stderr}`
}

/**
 * One enumeration per command per process, shared by every seat.
 *
 * The issue asks for "one subprocess before a run", and a four-seat run naming the same agent
 * four times would otherwise run four. Keyed by the command line rather than by agent id, so two
 * definitions asking the same question share the answer and one asking a different question does
 * not inherit it. The promise is cached rather than the result, so seats joined concurrently
 * queue on the first ask instead of racing a second.
 */
const asked = new Map<string, Promise<AskOutcome>>()

interface AskOutcome {
  names: string[]
  /** Why there are no names, when the ask itself failed. */
  failure?: string | undefined
}

/** Tests, and any caller that wants the next ask to actually happen. */
export function forgetModelEnumerations(): void {
  asked.clear()
}

async function enumerate(support: ModelSupport, ask: AskCli): Promise<AskOutcome> {
  const spec = support.ask
  if (!spec) return { names: [], failure: support.reason ?? 'this agent declares no way to list its models' }
  const key = [spec.command, ...spec.args].join(' ')
  const cached = asked.get(key)
  if (cached) return cached
  const pending = (async (): Promise<AskOutcome> => {
    try {
      const names = spec.parse(await ask(spec.command, spec.args))
      if (names.length === 0) {
        return { names, failure: `\`${key}\` answered, but named nothing this knows how to read` }
      }
      return { names }
    } catch (e) {
      return { names: [], failure: `\`${key}\` could not be run: ${e instanceof Error ? e.message : String(e)}` }
    }
  })()
  asked.set(key, pending)
  return pending
}

/**
 * Names worth putting in front of someone who just mistyped one.
 *
 * `opencode models` lists sixty; printing sixty lines at someone whose real problem is a missing
 * `-code` suffix buries the answer. The full list is one command away and the refusal says so.
 */
export function nearestNames(model: string, names: readonly string[], limit = 5): string[] {
  // Compared on the MODEL half, after the provider. Every name in an `opencode models` list
  // begins `opencode/`, so a whole-string prefix score ranks the alphabet rather than the
  // near misses -- it offered `opencode/big-pickle` for `opencode/kimi-k9`.
  const tailOf = (s: string): string => s.toLowerCase().slice(s.lastIndexOf('/') + 1)
  const needle = tailOf(model)
  const scored = names
    .map((name) => {
      const other = tailOf(name)
      let shared = 0
      while (shared < other.length && shared < needle.length && other[shared] === needle[shared]) shared++
      const contains = needle.length >= 3 && (other.includes(needle) || needle.includes(other))
      return { name, score: shared + (contains ? 8 : 0) }
    })
    .filter((s) => s.score >= 3)
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1))
  return scored.slice(0, limit).map((s) => s.name)
}

/** Every name, when there are few enough to read, or the closest ones and where the rest are. */
function optionsLine(model: string, names: readonly string[], support: ModelSupport, asking: string): string {
  if (names.length <= 12) return `  the ${support.nounPlural} it names: ${names.join(', ')}`
  const near = nearestNames(model, names)
  const closest = near.length > 0 ? `  closest: ${near.join(', ')}\n` : ''
  return `${closest}  all ${names.length} ${support.nounPlural}: run \`${asking}\``
}

/**
 * What can be established about one seat's model selection, without launching it.
 *
 * Never throws for a bad model: the refusal is a value, so a caller checking four seats can
 * report all four rather than the first.
 */
export async function checkModelSelection(
  selection: ModelSelection,
  opts: { ask?: AskCli | undefined } = {},
): Promise<ModelCheck | undefined> {
  const { participant, agent, model } = selection
  // An argv that named no model selected nothing, so there is nothing to be wrong about and no
  // subprocess to spend finding that out.
  if (model === null) return undefined
  const support = agent.models
  const base = { participant, agent: agent.id, model }
  if (!support) {
    return { ...base, grade: 'undeclared', unchecked: `agent '${agent.id}' declares no model validation` }
  }
  if (support.grade === 'unsupported') {
    return {
      ...base,
      grade: 'unsupported',
      unchecked: support.reason ?? `${agent.id} cannot be asked which models it accepts`,
    }
  }
  if (support.judges && !support.judges(model)) {
    return {
      ...base,
      grade: support.grade,
      unchecked:
        `'${model}' is not a name \`${agent.launch.command}\` enumerates: only ${support.noun}-shaped ` +
        `selections are checked, and this one is passed through`,
    }
  }
  const { names, failure } = await enumerate(support, opts.ask ?? defaultAsk)
  if (failure !== undefined) return { ...base, grade: support.grade, unchecked: failure }
  if (names.includes(support.normalize ? support.normalize(model) : model)) {
    return { ...base, grade: support.grade }
  }
  const asking = [support.ask!.command, ...support.ask!.args].join(' ')
  return {
    ...base,
    grade: support.grade,
    refusal:
      `${participant} (${agent.id}) was launched with the model '${model}', which is not one of ` +
      `the ${support.nounPlural} \`${asking}\` names.\n` +
      `${optionsLine(model, names, support, asking)}`,
  }
}

/**
 * Refuse a run whose seats name models their children do not have.
 *
 * Every seat is checked before any of them is reported on, so an operator who mistyped two
 * models is told about two rather than made to run twice. Throwing is the right shape here and a
 * warning is not: the whole finding of #82 is that this failure is SILENT downstream -- the child
 * starts, says nothing, and is killed by a clock twelve minutes later -- so a line of output on a
 * run that then proceeds anyway would be a line nobody reads until the same twelve minutes have
 * passed.
 */
export async function refuseUnknownModels(
  selections: readonly ModelSelection[],
  opts: { ask?: AskCli | undefined } = {},
): Promise<ModelCheck[]> {
  const checks: ModelCheck[] = []
  for (const selection of selections) {
    const check = await checkModelSelection(selection, opts)
    if (check) checks.push(check)
  }
  const refused = checks.filter((c) => c.refusal !== undefined)
  if (refused.length > 0) {
    throw new Error(
      `${refused.map((c) => c.refusal).join('\n')}\n` +
        `Refusing to start. A child given a model it does not have produces no output at all and ` +
        `dies at the watchdog with no reason given (#82).`,
    )
  }
  return checks
}

/**
 * The aliases inside claude's `--model` option text.
 *
 * `claude --help` is the only non-interactive source claude has: there is no `claude models`, and
 * `--model` with no value opens a picker that needs a terminal. The option text on 2.1.x reads
 *
 *   --model <model>   Model for the current session. Provide an alias for the latest model
 *                     (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g.
 *                     'claude-fable-5').
 *
 * so the parse is: the option's own block, up to the sentence about full names, and the quoted
 * identifiers in it. Cutting at "full name" is what keeps `claude-fable-5` out of the alias set --
 * it is an example of the OTHER thing the flag takes, and treating it as an alias would make the
 * set describe neither half.
 *
 * Returns `[]` rather than guessing when the shape is not found, which leaves every selection
 * unchecked. A reworded help text must cost a diagnostic, never a false refusal.
 */
export function claudeAliases(help: string): string[] {
  const lines = help.split('\n')
  const start = lines.findIndex((l) => /^\s*--model\s+</.test(l))
  if (start < 0) return []
  const block = [lines[start]!]
  for (const line of lines.slice(start + 1)) {
    // The next option ends this one. Continuation lines are indented past the flag column and
    // never begin with a flag of their own.
    if (/^\s*-{1,2}[A-Za-z]/.test(line) || line.trim() === '') break
    block.push(line)
  }
  const text = block.join(' ').replace(/\s+/g, ' ')
  const aliasHalf = text.split(/full name/i)[0]!
  // Quoted IDENTIFIERS, so the apostrophe in "a model's full name" cannot open a quotation that
  // swallows the rest of the sentence as an alias.
  return [...aliasHalf.matchAll(/'([A-Za-z0-9][A-Za-z0-9._-]*)'/g)].map((m) => m[1]!)
}

/**
 * Whether a claude `--model` value is the kind of name the alias list can judge.
 *
 * An alias is short and bare -- `opus`, `sonnet`, `fable`. A full model name carries the vendor
 * in it (`claude-opus-5`), and the provider-routed spellings carry a separator (`us.anthropic.`,
 * a Bedrock arn, a gateway `provider/model`). Anything in the second group is passed through
 * unjudged, because the help text says explicitly that claude takes them and does not list them.
 *
 * The `[1m]` suffix is stripped before judging: `sonnet[1m]` selects the `sonnet` alias with a
 * context window attached, and refusing it would be this validator inventing a rule the child
 * does not have.
 */
export function isClaudeAliasShaped(model: string): boolean {
  const bare = model.replace(/\[[^\]]*\]$/, '')
  return !/claude|anthropic|[./:@]/i.test(bare)
}

/** The `sonnet[1m]` form again, on the way in to the comparison. */
export function claudeAliasOf(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '')
}

/** One `provider/model` per line, which is the whole of `opencode models` output. */
export function opencodeModels(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('/') && !/\s/.test(l))
}
