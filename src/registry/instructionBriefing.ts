/**
 * The canonical capability terms, as ordered data, and a pure renderer from them to the block
 * an advisor reads.
 *
 * TWO THINGS ARE SEPARATED HERE and the separation is the point. `instructionCapabilities.ts`
 * holds what each agent was found to advertise; this file holds what each capability MEANS and
 * how it is said. A run's briefing is then a function of the two, and of nothing else.
 *
 * TWO LISTS, ONE BLOCK. The block also carries the slash commands the seat's policy ALLOWS,
 * and they are a different kind of thing from a capability: a capability is something the seat
 * can be told to do inside its own turn, a command is something the ORCHESTRATOR types into
 * the seat's composer on the advisor's behalf. They share a block because they answer one
 * question -- what may I ask of this seat -- and they are separately headed inside it because
 * an advisor that confused them would write an instruction where a directive was needed, or
 * expect a `COMMAND:` line to do work.
 *
 * ONLY ALLOWED COMMANDS ARE RENDERED, and `commandPolicy.ts` is where a refusal is written
 * down and argued. A refused verb listed here with its reason would read as an invitation to
 * try it, and an advisor that spends a turn asking for a refusal has spent a turn on a note in
 * the routing log. `unsupported` and absence render nothing for the same reason silence
 * renders nothing on the capability side.
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

import type { CommandDeclaration, CommandPolicy, InstructionCapabilities } from './types.ts'

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
  /**
   * Present when the capability is REAL but is not something this orchestrator can act on, and
   * why, in one sentence. A descriptor carrying this is data and renders nothing.
   *
   * The row stays because the term is still canonical vocabulary and the claims read off the
   * CLIs are still true: `instructionCapabilities.ts` records what each agent advertises, and
   * deleting the descriptor would delete the compile guard below along with the only place the
   * term is spelled. What is dropped is the SENTENCE, because the advisor cannot usefully act
   * on it here -- and an advisor told it may instruct something the relay cannot hold would
   * spend turns on a lever attached to nothing.
   */
  notInstructable?: string
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
    // NOT INSTRUCTABLE HERE, and the reason is structural rather than a policy anyone chose.
    // `Relay#exchangeTurn` sends once and returns on the FIRST `turn_end` after that send --
    // one `turn_end` per exchange, by construction -- and it increments `#turnsTaken` exactly
    // once per dispatch, before the send. A turn the seat gives itself therefore arrives after
    // the exchange has already returned: it is not the report the relay collected, and it
    // appears in NEITHER of the two counters that bound a run. `#turnsTaken` is what the turn
    // ceiling reads (`--max-turns`), and it was incremented for the dispatched turn alone; the
    // advisor loop's own counter is what `--rounds` bounds, and a turn nobody asked for is not
    // an iteration of that loop. So the work happens and no allowance is charged for it.
    //
    // SAID NARROWLY ON PURPOSE. This is an accounting claim about two integers and nothing
    // more. It is NOT a claim about `--max-minutes`, which reads `activeMs` -- wall-clock net
    // of pauses -- and goes on running while a self-dispatched turn does, so nothing here
    // evades it. The capability is genuine and stays declared; what would be false is telling
    // an advisor it may instruct a seat to use it here.
    notInstructable:
      'the relay takes one `turn_end` per exchange, so a turn the seat gives itself is counted ' +
      'by neither the turn ceiling nor the advisor loop',
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
 * ONLY DECLARED, SUPPORTED CLAIMS WITH AN INSTRUCTABLE DESCRIPTOR ARE RENDERED, and the ways a
 * capability can fail to appear are deliberately indistinguishable in the output while staying
 * distinct in the data. An absent field is "nobody established this"; a `supported: false` is
 * "asked and answered no"; a descriptor carrying `notInstructable` is "advertised by the CLI and
 * useless to this orchestrator". None of the three is something the advisor should be told the
 * seat can be instructed to do. Silence is the only honest rendering of all of them, and
 * inventing a "cannot" line would report a limit nobody verified.
 *
 * WHICH IS WHY THE CLOSING SENTENCE SAYS WHAT IT SAYS. It once read "anything not listed is
 * simply not claimed for that seat", which `notInstructable` makes FALSE: `autonomousLoop` is
 * claimed by two of the four built-in agents and is listed for none of them. The sentence now
 * says only that an unlisted capability is not to be instructed here, which holds under every
 * reason a row can be missing, and it does not offer a reason it cannot know.
 *
 * Returns EXACTLY the empty string when nothing qualifies, rather than a heading with an empty
 * list under it, so a caller can concatenate it unconditionally and a run whose seat declares
 * nothing pays no briefing tokens at all -- the rule every other conditional block in the
 * advisor's briefing already follows.
 *
 * EITHER LIST ALONE IS ENOUGH TO PRODUCE THE BLOCK. A seat with a reachable policy and no
 * declared capabilities is an ordinary case rather than a corner -- the two fields were read
 * from the CLI by different routes at different times -- and it gets the command half on its
 * own. This is why the capability declaration no longer short-circuits the whole function:
 * `undefined` there now means "no capability lines", not "no block".
 */
export const DEFAULT_CAPABILITY_SUBJECT = 'THE IMPLEMENTER SEAT IN THIS RUN'

/**
 * The entries of a policy that may be asked for, which is a strict subset of the ones it holds.
 *
 * `declared` is the only shape with entries at all; `unsupported` is a transport with no
 * composer and absence is nobody having read the CLI, and neither has a verb to offer. Within
 * `declared`, a REFUSAL is a considered entry and must not be rendered: the block is a list of
 * what may be asked for, and a refusal in it reads as a suggestion.
 */
function allowedCommands(policy: CommandPolicy | undefined): readonly CommandDeclaration[] {
  if (!policy || policy.kind !== 'declared') return []
  return policy.commands.filter((c) => c.disposition === 'allowed')
}

export function instructionCapabilityBriefing(
  descriptors: readonly CapabilityDescriptor[],
  declared: InstructionCapabilities | undefined,
  subject: string = DEFAULT_CAPABILITY_SUBJECT,
  policy?: CommandPolicy | undefined,
): string {
  const lines = !declared
    ? []
    : descriptors.flatMap((d) => {
        // A `notInstructable` descriptor is skipped BEFORE the claim is read, so a seat
        // declaring nothing else renders the empty string rather than a heading over an empty
        // list -- the same silence an absent declaration gets, for the same reason.
        if (d.notInstructable !== undefined) return []
        const claim = declared[d.key]
        return claim?.supported === true ? [`  - ${d.term} — ${d.instruction}.`] : []
      })
  const commands = allowedCommands(policy)
  if (lines.length === 0 && commands.length === 0) return ''

  // Assembled as sections joined by one blank line, and with no commands that is byte-for-byte
  // the block this function returned before commands existed. That identity is the point: a
  // seat with capabilities and no reachable policy must not read differently for a feature it
  // does not have.
  const sections: string[] = []
  if (lines.length > 0) {
    sections.push(
      `${subject} CAN BE INSTRUCTED TO DO THE FOLLOWING. These are things the seated agent can ` +
        `be TOLD to do, not a record of what it has already done:\n\n${lines.join('\n')}`,
    )
  }
  if (commands.length > 0) {
    // The example is taken from the list rather than written here, so it cannot come to name a
    // command this seat does not have -- which is the one error in a syntax lesson that would
    // teach the advisor to write a line that is always refused.
    const example = commands[0] as CommandDeclaration
    sections.push(
      `${subject} CAN ALSO BE ASKED TO RUN THESE SLASH COMMANDS. A command changes how the ` +
        `seat WORKS; it is not an instruction and it does no work:\n\n` +
        `${commands.map((c) => `  - ${c.command}${c.argumentHint ? ` ${c.argumentHint}` : ''} — ${c.description}`).join('\n')}\n\n` +
        `Ask for one on a line of ITS OWN, with nothing else on that line:\n\n` +
        `COMMAND: ${example.command}\n\n` +
        `That line is lifted OUT of your reply and is never delivered to the seat as prose; ` +
        `the rest of your reply is still the instruction. What you are writing is a REQUEST ` +
        `rather than an effect. It is held until the seat reaches a TURN BOUNDARY, so it is ` +
        `never typed into a turn already running and it does not take effect at the moment you ` +
        `ask for it. Nothing reads what the seat does with it either — the submission is ` +
        `recorded, the outcome is not — so treat neither the submission nor its result as ` +
        `confirmed.`,
    )
  }
  sections.push(
    `Anything not listed is not something to ask of this seat in this run, and this block says ` +
      `nothing further about why.`,
  )
  return sections.join('\n\n')
}

/** One writing seat and whatever its agent declares, which may be nothing. */
export interface SeatDeclaration {
  /** The SEAT id, the name the advisor addresses. Never the agent id. */
  id: string
  declared: InstructionCapabilities | undefined
  /**
   * The seat's command policy, when a command asked for by the advisor would actually be typed
   * into THIS seat.
   *
   * Optional and frequently absent even where a policy exists, because delivery is narrower
   * than declaration: `Relay#submitAdvisorCommands` sends to `#implementers()[0]` -- a
   * `COMMAND:` line names no seat and there is no syntax for one -- so at N>1 every other seat
   * has a policy that nothing can reach. The caller decides which seat that is; this file
   * renders what it is handed and has no way to ask.
   */
  commands?: CommandPolicy | undefined
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
      seat.commands,
    )
    return text === '' ? [] : [text]
  })
  if (blocks.length === 0) return ''
  return labelled ? `${PER_SEAT_PREAMBLE}\n\n${blocks.join('\n\n')}` : blocks.join('\n\n')
}
