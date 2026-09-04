/**
 * What a seat was launched with, and which model that names.
 *
 * Composed in ONE place because it is now RECORDED as well as used. `#71` asks the record to
 * name the model and the launch args per seat, and an arg vector assembled separately for the
 * record would be a second answer to "what ran" -- the class of defect this codebase keeps
 * finding in itself. Every built-in adapter builds its child's argv here, and the relay reads
 * the same function to write it down.
 */

import type { CreateParticipantContext, ResolvedParticipant } from './types.ts'

/**
 * How a seat was started, as a fact about the run rather than a setting.
 *
 * `args` is the ground truth and `model` is derived from it. Both are reported, because
 * neither answers the other's question: the model is the join key an operator correlates
 * against their provider's billing export, and the args are what they would have to type to
 * repeat the run.
 */
export interface ParticipantLaunch {
  /** The whole argv this seat's adapter was given, adapter base args included. */
  args: string[]
  /** The model named on that argv, or `null` when it names none. */
  model: string | null
}

/**
 * The argv an adapter spreads into its child process.
 *
 * Three layers in a fixed order, and the order is the precedence: the adapter's own base
 * args, then the participant spec (project config, then the operator's `--implementer-args`,
 * already composed by the front-end), then anything the creating context adds. Later wins,
 * which is what makes an explicitly typed flag beat a configured one.
 */
export function effectiveLaunchArgs(
  resolved: ResolvedParticipant,
  ctx: CreateParticipantContext,
): string[] {
  return [...resolved.agent.launch.baseArgs, ...(resolved.spec.args ?? []), ...(ctx.args ?? [])]
}

/** Both halves of the record, from the one composition above. */
export function launchRecordFor(
  resolved: ResolvedParticipant,
  ctx: CreateParticipantContext,
): ParticipantLaunch {
  const args = effectiveLaunchArgs(resolved, ctx)
  return { args, model: modelFromArgs(args) }
}

/** `-m X` and `--model X`, in both their separated and `=` spellings. */
const MODEL_FLAGS = new Set(['-m', '--model'])
/** `-c key=value`, which is how Codex takes `model` without a flag of its own. */
const CONFIG_FLAGS = new Set(['-c', '--config'])
const INLINE_MODEL = /^(?:-m|--model)=(.*)$/
const CONFIG_MODEL = /^model=(.*)$/

/**
 * The model a launch argv names, or `null` when it names none.
 *
 * `null` rather than `''`, and the distinction is the point of the field: "the command line
 * selected no model" is a fact about the run, while an empty string is indistinguishable from
 * a model whose name failed to survive being recorded. `#71` asks for exactly this -- a run
 * started with no explicit model must record THAT, not a blank.
 *
 * Recognised spellings, and nothing else: `-m X`, `--model X`, `-m=X`, `--model=X`, and
 * `-c model=X` / `-c model="X"`. LAST occurrence wins, matching both the child CLIs and the
 * order `effectiveLaunchArgs` composes: the flag the operator typed comes after the one their
 * project config supplied, so the one reported is the one that took effect.
 *
 * Deliberately NOT keyed by agent. An `agent === 'opencode'` table here would be a copy of
 * knowledge belonging to the adapter, in a module with no way to stay in step with it -- the
 * same argument `Relay.deadlines` makes for reading the support table through the registry.
 * The cost is real and is stated rather than hidden: a model chosen some other way -- Kimi's
 * `--config-file`, a provider default, an environment variable -- reads as `null`. `null`
 * says the argv named no model. It does not say the run had none, and the argv is recorded
 * beside it so a reader can see for themselves.
 */
export function modelFromArgs(args: readonly string[]): string | null {
  let found: string | null = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const inline = INLINE_MODEL.exec(arg)
    if (inline) {
      found = value(inline[1]!) ?? found
      continue
    }
    if (MODEL_FLAGS.has(arg)) {
      const next = args[i + 1]
      // A flag with nothing after it, or with another flag after it, selected nothing. Taking
      // the next token unconditionally would report `--verbose` as the model that ran.
      if (next !== undefined && !next.startsWith('-')) {
        found = value(next) ?? found
        i++
      }
      continue
    }
    if (CONFIG_FLAGS.has(arg)) {
      const kv = CONFIG_MODEL.exec(args[i + 1] ?? '')
      if (kv) {
        found = value(kv[1]!) ?? found
        i++
      }
    }
  }
  return found
}

/**
 * The args left once the ones that selected the model are taken out (#221).
 *
 * Beside `modelFromArgs` and walking the same spellings deliberately. A transport that consumes
 * the model separately -- OpenCode's API takes it per prompt rather than in argv -- needs to know
 * which tokens it has already used, and a second copy of `-m` / `--model` / `-c model=` written
 * where that answer was needed would drift the first time a spelling is added here. When the two
 * disagree, the seat reports an arg as undeliverable while acting on it, which is a worse report
 * than saying nothing.
 */
export function argsWithoutModel(args: readonly string[]): string[] {
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (INLINE_MODEL.test(arg)) continue
    if (MODEL_FLAGS.has(arg)) {
      const next = args[i + 1]
      // Consume the value only when `modelFromArgs` would have. A dangling `--model` selected
      // nothing, so it is undeliverable like any other arg and belongs in what is reported.
      if (next !== undefined && !next.startsWith('-')) {
        i++
        continue
      }
      rest.push(arg)
      continue
    }
    if (CONFIG_FLAGS.has(arg) && CONFIG_MODEL.test(args[i + 1] ?? '')) {
      i++
      continue
    }
    rest.push(arg)
  }
  return rest
}

/** A quoted or bare value, or `undefined` when there is nothing left of it. */
function value(raw: string): string | undefined {
  const trimmed = raw.trim()
  const unquoted =
    trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'")) && trimmed.endsWith(trimmed[0]!)
      ? trimmed.slice(1, -1)
      : trimmed
  return unquoted.length > 0 ? unquoted : undefined
}
