/**
 * The canonical capability terms, as ordered data, and a pure renderer from them to the block
 * an advisor reads.
 *
 * TWO THINGS ARE SEPARATED HERE and the separation is the point. `instructionCapabilities.ts`
 * holds what each agent was found to advertise; this file holds what each capability MEANS and
 * how it is said. A run's briefing is then a function of the two, and of nothing else.
 *
 * NO AGENT ID REACHES THIS FILE. `instructionCapabilityBriefing` takes descriptors and a
 * declaration, so there is no id to branch on and no place to put one. That is deliberate and it
 * is `DeadlineSupport`'s argument one layer out: "An id check is a copy of this table that no one
 * updates, and it lands in whichever module happened to need the answer first." A renderer that
 * told one agent from another would be a second capability table, kept in prose, drifting from
 * the one in `instructionCapabilities.ts` the first time either moved. The test file scans this
 * source for every built-in id, and renders declarations that differ ONLY in which CLI they were
 * read from, because the guard has to survive the NEXT edit rather than this one.
 *
 * WHAT THE BLOCK DOES NOT SAY. It states no evidence level and no freshness. `GradedClaim`
 * admits `observed` as readily as `inferred_from_documented_event`, so a sentence here calling
 * every listed capability an unwatched advertisement would be FALSE the first time a fixture
 * promoted one -- and false in the worst direction, understating something that had actually
 * been proven. Grades belong where they can be read per claim; this block says only that the
 * seat can be instructed, which is true at every grade a claim can hold.
 */

import type { InstructionCapabilities } from './types.ts'

/**
 * What one capability is called and how it is put to the advisor.
 *
 * `instruction` completes the sentence "the implementer seat can be instructed to ___", which is
 * why every one of them below starts with a bare verb. The renderer supplies that frame once and
 * never rewrites the text, so a change of wording is a change to this table alone.
 */
export interface CapabilityDescriptor {
  /** The field in `InstructionCapabilities` this describes. */
  key: keyof InstructionCapabilities
  /** The canonical term, finer than any vendor's own. */
  term: string
  /** The instruction itself, as the advisor should read it. */
  instruction: string
}

/**
 * All seven canonical terms, in the order they are rendered.
 *
 * ORDER IS DATA, not the order the fields happen to sit in a declaration. Rendering by
 * iterating whatever the agent declared would order the block by the accident of how that
 * literal was typed, so two agents advertising the same four capabilities could read
 * differently. The three background rows are adjacent and in escalating scope -- start it,
 * finish it by turn end, detach the whole session -- because the failure this list exists to
 * prevent is reading them as one capability.
 */
export const CAPABILITY_DESCRIPTORS = [
  {
    key: 'subagents',
    term: 'bounded subagent delegation',
    instruction:
      'delegate to subagents, which are spawned, awaited and reconciled INSIDE one turn, so ' +
      'their work is part of the report that turn produces',
  },
  {
    key: 'backgroundTasks',
    term: 'background task execution',
    instruction:
      'start a task WITHOUT the starting call waiting for it. This says nothing whatsoever ' +
      'about when that task ends: starting work in the background and having it finished by ' +
      'the end of the turn are two different capabilities, and only the first is claimed here',
  },
  {
    key: 'turnBoundedLifetime',
    term: 'turn-bounded lifetime',
    instruction:
      'have such a background task FINISHED, or explicitly awaited, by the time the turn ends ' +
      '— so nothing it produces lands after the report that turn was judged on',
  },
  {
    key: 'sessionBackgrounding',
    term: 'whole-session backgrounding',
    instruction:
      'detach the WHOLE SESSION and reattach to it later by id. This is a property of the ' +
      'session rather than of a turn, and it is not a way to run a task in the background',
  },
  {
    key: 'asyncPromptSubmission',
    term: 'async prompt submission',
    instruction:
      'accept a prompt from a call that returns BEFORE the reply does, with the session ' +
      'staying in the foreground throughout',
  },
  {
    key: 'boundedIteration',
    term: 'bounded agentic iteration',
    instruction: 'take many steps within a single invocation, under a cap on how many',
  },
  {
    key: 'autonomousLoop',
    term: 'autonomous cross-turn continuation',
    instruction:
      'choose and dispatch a SUBSEQUENT turn of its own, rather than stopping and waiting to ' +
      'be given the next one',
  },
] as const satisfies readonly CapabilityDescriptor[]

/**
 * A capability that gains a field and no descriptor fails to compile here.
 *
 * Without this, adding a term to `InstructionCapabilities` would silently render nothing --
 * the quietest possible failure, because a briefing that omits a capability looks exactly like
 * a briefing for an agent that lacks it.
 */
type UndescribedTerm = Exclude<
  keyof Required<InstructionCapabilities>,
  (typeof CAPABILITY_DESCRIPTORS)[number]['key']
>
const _EVERY_TERM_HAS_A_DESCRIPTOR: UndescribedTerm extends never ? true : UndescribedTerm = true
void _EVERY_TERM_HAS_A_DESCRIPTOR

/**
 * The block the advisor is given about what the seated implementer can be TOLD to do.
 *
 * Pure: same descriptors and same declaration, same string, every time. It reads no clock, no
 * registry and no seat.
 *
 * ONLY DECLARED, SUPPORTED CLAIMS ARE RENDERED, and the three ways a capability can fail to
 * appear are deliberately indistinguishable in the output while staying distinct in the data.
 * An absent field is "nobody established this"; a `supported: false` is "asked and answered no";
 * neither is something the advisor should be told the seat can do. Silence is the only honest
 * rendering of both, and inventing a "cannot" line for them would report a limit nobody verified.
 *
 * Returns EXACTLY the empty string when nothing qualifies, rather than a heading with an empty
 * list under it, so a caller can concatenate it unconditionally and a run whose seat declares
 * nothing pays no briefing tokens at all -- the rule every other conditional block in the
 * advisor's briefing already follows.
 */
export const DEFAULT_CAPABILITY_SUBJECT = 'THE IMPLEMENTER SEAT IN THIS RUN'

export function instructionCapabilityBriefing(
  descriptors: readonly CapabilityDescriptor[],
  declared: InstructionCapabilities | undefined,
  subject: string = DEFAULT_CAPABILITY_SUBJECT,
): string {
  if (!declared) return ''
  const lines = descriptors.flatMap((d) => {
    const claim = declared[d.key]
    return claim?.supported === true ? [`  - ${d.term} — ${d.instruction}.`] : []
  })
  if (lines.length === 0) return ''
  return (
    `${subject} CAN BE INSTRUCTED TO DO THE FOLLOWING. These are things the seated agent can ` +
    `be TOLD to do, not a record of what it has already done:\n\n${lines.join('\n')}\n\n` +
    `Anything not listed is simply not claimed for that seat, and this block says nothing ` +
    `further about it.`
  )
}

/** One writing seat and whatever its agent declares, which may be nothing. */
export interface SeatDeclaration {
  /** The SEAT id, the name the advisor addresses. Never the agent id. */
  id: string
  declared: InstructionCapabilities | undefined
}

/**
 * The preamble a multi-seat run gets, once, above the per-seat blocks.
 *
 * Its whole job is to stop the lists being read as one list, and it claims NOTHING BEYOND THAT.
 * An earlier draft opened "these seats do not all take the same instructions", which is a claim
 * about the seats this function is in no position to make: two seats on the same agent take
 * exactly the same instructions, and that is the common case rather than a corner. Attribution
 * is the fact here -- each list was declared for one seat -- and whether the lists happen to
 * differ is something the advisor can see for itself by reading them.
 */
const PER_SEAT_PREAMBLE = `EACH BLOCK BELOW IS ATTRIBUTED TO ONE SEAT. What is listed under a seat was declared for that
seat, and says nothing either way about any other seat. Read each list against the seat it
names, and address work to the seat whose list carries it.`

/**
 * Every writing seat's block, composed.
 *
 * ONE SEAT renders the singular block byte-for-byte as it renders alone, because a run with
 * one seat has nothing to disambiguate and should not pay for a distinction it does not have --
 * the rule every other conditional block in this briefing already follows.
 *
 * MORE THAN ONE SEAT labels every block with its seat id, and the gate is the SEAT COUNT rather
 * than the number of blocks that came back non-empty. Two seats where only one declares still
 * needs the label: unlabelled, the advisor reads a single list and has no way to tell which of
 * its two seats it belongs to, which is the conflation this exists to prevent.
 *
 * NO AGENT ID PASSES THROUGH HERE either. A `SeatDeclaration` carries the seat's own name and
 * the claims resolved for it; which agent that seat sits on is already spent by the time this
 * is called, and is not recoverable from what it is given.
 */
export function instructionBriefingForSeats(
  descriptors: readonly CapabilityDescriptor[],
  seats: readonly SeatDeclaration[],
): string {
  const labelled = seats.length > 1
  const blocks = seats.flatMap((seat) => {
    const text = instructionCapabilityBriefing(
      descriptors,
      seat.declared,
      labelled ? `SEAT ${seat.id}` : DEFAULT_CAPABILITY_SUBJECT,
    )
    return text === '' ? [] : [text]
  })
  if (blocks.length === 0) return ''
  return labelled ? `${PER_SEAT_PREAMBLE}\n\n${blocks.join('\n\n')}` : blocks.join('\n\n')
}
