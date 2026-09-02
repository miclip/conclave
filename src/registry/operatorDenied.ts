/**
 * What an operator may switch off in `.conclave/config.json`, and what it may not.
 *
 * TWO RULES, and neither is negotiable. Everything in this file is one of them applied.
 *
 * ABSENCE IS IDENTITY. A project with no `capabilities` and no `commands` map -- which is
 * every project that existed before this file -- must produce byte-for-byte the run it
 * produced before, down to the advisor's opening prompt. That is why `narrowCapabilities` and
 * `narrowPolicy` return the SAME OBJECT they were given when there is nothing to deny, rather
 * than an equal copy: an identity that holds by construction cannot be broken by a later edit
 * that changes how a copy is built. A config feature whose "off" state is merely equivalent is
 * a feature every existing project pays for.
 *
 * CONFIG MAY ONLY NARROW, NEVER WIDEN. A capability is declared because someone read it off
 * the installed CLI; a command is allowed because someone argued it cannot break the run. A
 * project file may withhold either -- that is the operator declining something offered to them
 * -- and may not add either, because the thing it would be overruling is not a preference.
 * The refusals in `commandPolicy.ts` protect CONTINUITY (the relay goes on addressing a seat
 * whose history is gone), the PARSER (`CodexPtyHookAdapter` latches a transcript path and
 * tails a rollout nothing writes to any more) and the REPORT (the launch model is stated once
 * and never revised). Those guarantees are conclave's to keep, not a project's to waive, and
 * an operator who could write `"/clear": true` would be waiving one on behalf of every later
 * reader of that run's report. So `true` is refused at READ, with the policy's own reason
 * quoted back, rather than accepted-and-ignored -- an ignored setting is worse than a rejected
 * one, because the operator believes it took effect.
 *
 * WHY NARROWING IS NOT A REGISTRY EDIT. The registry holds what was READ off each CLI, and
 * that stays true whatever a project prefers. These functions produce a per-run VIEW of it and
 * the canonical data is never touched, so two runs in two projects against one registry cannot
 * see each other's configuration -- and a report that says what the adapter declares goes on
 * saying it.
 */

import { CLAUDE_COMMAND_POLICY, CODEX_COMMAND_POLICY } from './commandPolicy.ts'
import { CAPABILITY_DESCRIPTORS } from './instructionBriefing.ts'
import type { CommandDeclaration, CommandPolicy, InstructionCapabilities } from './types.ts'

/**
 * What one project switched off, already validated.
 *
 * Deny-only by construction: there is no field here for a capability to be turned ON, so a
 * widening cannot reach this far even by mistake. `readProjectConfig` is where the attempt is
 * refused; this shape is why there is nowhere for it to go if it were not.
 */
export interface OperatorDenials {
  /** Canonical capability terms, as `InstructionCapabilities` spells them. */
  capabilities: readonly string[]
  /** Commands, leading slash included, exactly as a policy declares them. */
  commands: readonly string[]
}

/**
 * Every capability name a config may name, which is the canonical vocabulary and nothing else.
 *
 * Read off `CAPABILITY_DESCRIPTORS` rather than written out, so a term added there is deniable
 * the same day. A second hand-maintained list is the thing this project's `DeadlineSupport`
 * note warns about: a copy nobody updates, landing wherever it was first needed.
 */
export const DENIABLE_CAPABILITIES: readonly string[] = CAPABILITY_DESCRIPTORS.map((d) => d.key)

/**
 * Every declaration both built-in policies hold, flattened.
 *
 * Narrowed through `kind === 'declared'` rather than cast. The two pty policies declare lists
 * today and the other two are `unsupported`; a cast would go on compiling the day one of them
 * changed shape, and would throw at import time in every command this binary has.
 */
const BUILTIN_DECLARATIONS: readonly CommandDeclaration[] = [
  CLAUDE_COMMAND_POLICY,
  CODEX_COMMAND_POLICY,
].flatMap((p) => (p.kind === 'declared' ? [...p.commands] : []))

/** Every command any built-in policy CONSIDERED, refusals included, sorted and deduplicated. */
export const DENIABLE_COMMANDS: readonly string[] = [
  ...new Set(BUILTIN_DECLARATIONS.map((c) => c.command)),
].sort()

/**
 * What a built-in policy says about a command, preferring a REFUSAL when one exists.
 *
 * The preference is the point rather than a tiebreak. A `true` written against `/clear` or
 * Codex's `/new` is an operator trying to re-enable exactly the commands that are refused for
 * correctness, and the useful answer names the correctness -- "the relay would go on
 * addressing a seat it believes has the run behind it" -- not "unsupported value". An operator
 * told only that it failed edits the file again; one told why edits their expectations.
 */
export function policyReasonFor(command: string): string | undefined {
  const all = BUILTIN_DECLARATIONS.filter((c) => c.command === command)
  return (all.find((c) => c.disposition === 'refused') ?? all[0])?.reason
}

/** Why a command the policy allows is nevertheless refused in THIS project. */
export function operatorDisabledReason(command: string): string {
  return (
    `${command} is allowed by this agent's policy but is switched off for this project in ` +
    `.conclave/config.json. Nothing is wrong with the seat or the command; the operator ` +
    `declined it, so it is not available for you to ask for in this run.`
  )
}

/**
 * The capabilities the advisor is briefed on: what the agent declares, less what was denied.
 *
 * A denied capability is REMOVED rather than set `supported: false`, and the two would render
 * identically today. Removal is still the honest one: `supported: false` means "asked and
 * answered no", a claim about the CLI, and an operator's preference is not evidence about
 * another program. Absence here means only "not offered in this run", which is what happened.
 */
export function narrowCapabilities(
  declared: InstructionCapabilities | undefined,
  denials: OperatorDenials | undefined,
): InstructionCapabilities | undefined {
  if (!declared || !denials || denials.capabilities.length === 0) return declared
  const out: InstructionCapabilities = {}
  for (const [key, claim] of Object.entries(declared) as [keyof InstructionCapabilities, never][]) {
    if (denials.capabilities.includes(key)) continue
    out[key] = claim
  }
  return out
}

/**
 * The policy a run actually uses: what the agent declares, with denied ALLOWANCES turned into
 * refusals that say who refused them.
 *
 * A denial makes an entry `refused`; it does not delete it. A deleted entry would be refused
 * anyway -- `ruleOnCommand` fails closed on anything undeclared -- but with the reason "not
 * declared in this agent's command policy", which is false and is the unhelpful half of false:
 * the advisor would read it as nobody having looked at the verb, and could reasonably ask a
 * human to look. An entry that says the operator switched it off is a fact the advisor can act
 * on by not asking again.
 *
 * A denial of something already REFUSED changes nothing at all, and neither does one against
 * an `unsupported` transport or an agent with no policy. Denying is subtraction, and there is
 * nothing to subtract from a set that never had the element.
 */
export function narrowPolicy(
  policy: CommandPolicy | undefined,
  denials: OperatorDenials | undefined,
): CommandPolicy | undefined {
  if (!policy || policy.kind !== 'declared' || !denials || denials.commands.length === 0) return policy
  const touches = policy.commands.some(
    (c) => c.disposition === 'allowed' && denials.commands.includes(c.command),
  )
  // Identity when nothing in THIS policy is denied, so a config that names a command belonging
  // to another agent leaves this one exactly as it was -- object and all.
  if (!touches) return policy
  const commands: CommandDeclaration[] = policy.commands.map((c) =>
    c.disposition === 'allowed' && denials.commands.includes(c.command)
      ? { ...c, disposition: 'refused' as const, reason: operatorDisabledReason(c.command) }
      : c,
  )
  return { ...policy, commands }
}
