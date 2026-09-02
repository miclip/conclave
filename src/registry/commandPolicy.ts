/**
 * Which slash commands the advisor may ask a seat to run, per adapter (#200).
 *
 * The rule these policies apply is stated on `CommandPolicy` in `./types.ts` and is not
 * restated here, because a rule written twice is a rule that will be two rules. What is here
 * is the application of it to four CLIs, and the evidence for each line.
 *
 * ALL FOUR BUILT-INS ARE COVERED, in two different ways, and the difference is not filing.
 * Claude and Codex hold a pty with a composer, so a command is a thing that could be typed
 * and the question is whether it may be -- they get `declared` lists, read out of their
 * installed bundles. OpenCode and Kimi run one process per turn with the prompt in argv and
 * no interactive session between turns, so there is nowhere to type a command at all -- they
 * get `unsupported`, which is a statement about the transport rather than about any verb.
 *
 * HOW THE LITERALS WERE DERIVED, and why they look nothing alike across the two:
 *
 *   Claude Code is a bundled JavaScript program and declares each command as an object
 *   literal, so `name:"compact"` and the description beside it are searchable and specific.
 *
 *   Codex is a Rust binary. Its command NAMES are interned into a packed string table with no
 *   separators -- `...logoutquitexitrolloutps...` -- and every short name in it also occurs
 *   somewhere else in a 220MB binary, so searching for `compact` proves precisely nothing.
 *   What is specific is each command's DESCRIPTION, which is long, unique, and unambiguously
 *   the slash-command help text. Those are what the Codex entries pin, and the two entries
 *   whose evidence is only the name table say so and quote the interned run.
 *
 * WHAT THIS FILE DOES NOT DO. It grants no command. Nothing submits anything to a seat on the
 * strength of an entry here: `ruleOnCommand` answers a question and the wiring that would act
 * on the answer -- the wait for the turn boundary, the unenveloped submit, the routing-log
 * record -- is not written. Declared first and separately on purpose, so the policy and its
 * evidence land in one reviewable step rather than as a footnote to the change that first
 * needs them.
 */

import type { CommandDeclaration, CommandPolicy } from './types.ts'

/** Verbatim `claude --version` on the machine every Claude literal below was read from. */
const CLAUDE_VERSION = '2.1.258 (Claude Code)'
/** Verbatim `codex --version` on the machine every Codex literal below was read from. */
const CODEX_VERSION = 'codex-cli 0.147.0'

export const CLAUDE_COMMAND_POLICY: CommandPolicy = {
  kind: 'declared',
  sourceVersion: CLAUDE_VERSION,
  commands: [
    {
      command: '/compact',
      disposition: 'allowed',
      reason:
        'Housekeeping, and continuity-preserving by its own description: it summarises the conversation rather than dropping it, so nothing the relay believes about this seat stops being true.',
      // Gated on an environment variable the operator may have set -- `isEnabled:()=>!Le(process.env.DISABLE_COMPACT)`
      // in the same declaration. So the command may be present and still refuse to run, which
      // is one of the two ways an allowed command can fail in a way no adapter observes.
      source: 'name:"compact",description:"Free up context by summarizing the conversation so far"',
    },
    {
      command: '/loop',
      disposition: 'refused',
      reason:
        'Makes the seat’s work unaccountable. It has the seat dispatch its own subsequent turns, and the relay takes one `turn_end` per exchange: a looped turn lands after `#exchangeTurn` has returned, so its report is not the report the relay collected and it is charged to neither `--max-turns` nor `--rounds`. The seat survives; the relay’s ability to say what it did, or to stop it doing more, does not.',
      // ALLOWED HERE UNTIL THE ACCOUNTING WAS WORKED THROUGH, and the reversal is the entry's
      // most useful fact. #200 read it as a work-mode change and it IS one -- the seat, its
      // context and its history are all untouched, which is why it passed the rule's first
      // clause. What it fails is the clause that clause did not have: `Relay#exchangeTurn`
      // returns on the FIRST `turn_end` after its send and increments `#turnsTaken` once per
      // dispatch, BEFORE the send, so every turn the seat gives itself is invisible to both
      // counters that bound a run. The verb is genuinely provided by the installed CLI and the
      // literal below is still checked against it; what is refused is our asking for it.
      //
      // THE SAME FAILURE `autonomousLoop` IS WITHHELD FOR. `CAPABILITY_DESCRIPTORS` in
      // `src/registry/instructionBriefing.ts` marks that capability `notInstructable` and the
      // advisor is never told a seat can be instructed to use it. Allowing the command while
      // withholding the capability would let the advisor reach by verb exactly what the
      // briefing declines to offer it by name.
      //
      // Stated narrowly: this is an accounting claim about two integers. It says nothing about
      // `--max-minutes`, which reads wall-clock net of pauses and goes on running throughout.
      //
      // A SKILL rather than a built-in command, which matters twice. It is shipped in the
      // bundle, so it is not an operator install -- but skill availability is per session and
      // nothing here observes it, so "the bundle ships it" is weaker than "this seat has it".
      source: 'menuDescription:"Repeat a prompt or command on an interval (e.g. /loop 5m /foo)"',
    },
    {
      command: '/clear',
      disposition: 'refused',
      reason:
        'Discards continuity. Its own description says the session is replaced by an empty one; the relay would go on addressing a seat it believes has the run behind it.',
      // The Claude adapter would FOLLOW this one: it reassigns `#transcriptPath` on every
      // `SessionStart`, and Claude Code dispatches one on a clear. So the parser survives and
      // the RELAY's belief does not, which is the more dangerous half -- an adapter reporting
      // healthy turns against a context that no longer contains the work being discussed.
      source:
        'name:"clear",description:"Start a new session with empty context; previous session stays on disk (resumable with /resume)"',
    },
    {
      command: '/rewind',
      disposition: 'refused',
      reason:
        'Discards continuity backwards. It restores the conversation to an earlier point, so turns the relay has already recorded, attributed and reported stop having happened -- the run report would describe a history the seat no longer has.',
      // Its aliases are the tell: `checkpoint` and `undo`. Worse than `/clear` for
      // attribution rather than better, because the seat afterwards looks continuous and is
      // not, so nothing about it reads as an event worth investigating.
      source: 'name:"rewind",aliases:["checkpoint","undo"]',
    },
    {
      command: '/exit',
      disposition: 'refused',
      reason:
        'Ends the seat. Every later instruction the relay routes to it is routed to a process that is gone, and the run finds out through a deadline rather than through the command.',
      source: 'name:"exit",aliases:["quit"]',
    },
    {
      command: '/quit',
      disposition: 'refused',
      // Declared in its own right rather than resolved through `/exit`. An undeclared command
      // is refused anyway, so this entry changes no outcome -- what it adds is that the alias
      // is CHECKED against the bundle, so the day `/quit` stops being a way to end the seat,
      // or starts meaning something else, this file has to be looked at.
      reason: 'The alias `/exit` ships, and it ends the seat for the same reason and by the same route.',
      source: 'name:"exit",aliases:["quit"]',
    },
    {
      command: '/model',
      disposition: 'refused',
      reason:
        'Alters operator configuration, and uniquely among these it makes an existing report FALSE rather than merely stale: the launch model is recorded once and never revised, so a mid-run switch leaves the report naming a model that is no longer the one answering.',
      // The CLI would tell us. 2.1.258 dispatches `PreModelSwitch` and `PostModelSwitch`, and
      // `HOOK_EVENTS` in `src/adapters/claude.ts` registers neither, so today a switch is
      // unobserved as well as unrecorded. Registering them would make the switch VISIBLE; it
      // would not make the launch-model report true, because that report is about launch.
      source: 'name:"model",supportsNonInteractive:!0,description:"Set the AI model for Claude Code"',
    },
    {
      command: '/config',
      disposition: 'refused',
      reason:
        'Alters operator configuration. The settings a seat launched under are the operator’s choices, and an advisor that can rewrite them is deciding how the run is set up rather than how the work is done.',
      // `ConfigChange` is dispatched by 2.1.258 and registered by nothing here either.
      source: 'name:"config",description:"Open settings"',
    },
    {
      command: '/permissions',
      disposition: 'refused',
      reason:
        'Alters operator configuration, and the part of it the operator is most entitled to hold: which tools the seat may use. An advisor that can widen the allow rules can grant itself, through the seat, capabilities the human declined to grant.',
      source: 'name:"permissions",aliases:["allowed-tools"],description:"Manage allow and deny tool permission rules"',
    },
    {
      command: '/hooks',
      disposition: 'refused',
      reason:
        'Alters operator configuration, and specifically the configuration conclave’s own evidence rests on: the adapter generates a hook registration and learns that a turn ended because `Stop` fires. A seat able to edit its hooks is a seat able to remove the thing that reports it finishing.',
      // The sharpest of the configuration refusals, and the only one that would break the
      // orchestrator rather than merely misdescribe it: with `Stop` unregistered there is no
      // turn-completion signal at all, and #36's symptom is a seat that runs a turn and never
      // reports finishing it until the watchdog says so.
      source: 'name:"hooks",description:"View hook configurations for tool events"',
    },
  ],
}

export const CODEX_COMMAND_POLICY: CommandPolicy = {
  kind: 'declared',
  sourceVersion: CODEX_VERSION,
  commands: [
    {
      command: '/compact',
      disposition: 'allowed',
      reason:
        'The same housekeeping allowance as on Claude, and on the same ground: it summarises the conversation to stay under the context limit rather than discarding it.',
      // This one needed settling rather than assuming, because Codex's `/new` is refused below
      // for starting a fresh rollout that the adapter's latched transcript path cannot follow,
      // and a `/compact` that did the same would have to be refused for the same reason.
      //
      // It does not. `compacted` is a RECORD TYPE within the rollout -- it sits in the
      // installed binary's record enum beside `session_meta`, `response_item`, `turn_context`
      // and `event_msg`, and conclave's own Codex parser already counts it by reading
      // `d.type === 'compacted'` out of the transcript it is tailing (`parseCodex` in
      // `src/transcript/parse.ts`). A compaction that began a new rollout could not be counted
      // from the old one, so the file the adapter holds open survives the command.
      source: 'summarize conversation to prevent hitting the context limit',
    },
    {
      command: '/review',
      disposition: 'allowed',
      reason:
        'A work-mode change: it puts the seat into reviewing its own changes. Nothing about the thread, its rollout or its history is replaced, so the relay’s belief about the seat survives it.',
      source: 'review my current changes and find issues',
    },
    {
      command: '/new',
      disposition: 'refused',
      reason:
        'Discards continuity, and on Codex it also breaks the PARSER, which is why this refusal is stronger than its Claude counterpart rather than merely parallel to it. `CodexPtyHookAdapter.#onHook` latches the transcript path the first time a hook carries one and never revises it, so a new chat leaves the adapter tailing a rollout the session has stopped writing to: no `task_complete` ever appears again and every later turn resolves by deadline.',
      source: 'start a new chat during a conversation',
    },
    {
      command: '/fork',
      disposition: 'refused',
      reason:
        'Discards continuity by the same route as `/new`: the fork is a different thread with a different rollout, and the latched transcript path still points at the one that was left behind.',
      source: 'fork the current chat',
    },
    {
      command: '/archive',
      disposition: 'refused',
      reason:
        'Ends the seat. Its own description says the session is archived AND exited, so it is `/exit` with a filing step attached.',
      source: 'archive this session and exit',
    },
    {
      command: '/quit',
      disposition: 'refused',
      reason: 'Ends the seat.',
      // Evidence of a different KIND from the entries above, and weaker, so it is spelled out
      // rather than dressed up: Codex interns its command names into a packed table, and this
      // is the run of that table containing `quit` and `exit` adjacently. It pins that the two
      // names are still in the command table; it does not pin what either one does.
      source: 'logoutquitexitrollout',
    },
    {
      command: '/exit',
      disposition: 'refused',
      reason: 'Ends the seat.',
      source: 'logoutquitexitrollout',
    },
    {
      command: '/model',
      disposition: 'refused',
      reason:
        'Alters operator configuration, and falsifies the immutable launch-model report exactly as it does on Claude. On Codex it moves the reasoning effort with the model, so one command changes two things the run report states as launch facts.',
      source: 'choose what model and reasoning effort to use',
    },
    {
      command: '/permissions',
      disposition: 'refused',
      reason:
        'Alters operator configuration, and on Codex it changes what the ADAPTER is asked to decide: this seat mediates approvals through `decidePermission`, so rewriting the approval policy rewrites the questions conclave answers on the operator’s behalf.',
      source: '/permissions - choose what Codex is allowed to do',
    },
  ],
}

/**
 * OpenCode and Kimi, which have no composer to type a command into.
 *
 * One shared constant because the reason is identical and STRUCTURAL rather than a coincidence
 * of two lists agreeing. Both adapters run one process per turn -- `opencode run --format json`
 * with the prompt after `--`, `kimi --print` with `stdio: ['ignore', ...]` so stdin is not even
 * connected -- and between turns there is no child at all. `InputQueue`, the thing that types
 * into a composer, is imported by `src/adapters/claude.ts` and `src/adapters/codex.ts` and by
 * no other adapter; `commandPolicy.test.ts` pins that, so this reason cannot quietly stop being
 * true while the sentence goes on being here.
 *
 * This is NOT the same answer as declaring every command refused. A refusal says the verb was
 * considered and rejected; this says the question does not arise, and the repair is a different
 * adapter rather than a different list.
 */
export const NO_COMPOSER_COMMAND_POLICY: CommandPolicy = {
  kind: 'unsupported',
  reason:
    'run-per-turn, no composer: one process per turn with the prompt in argv, no pty and no interactive session between turns, so there is nowhere to deliver a slash command',
}

/**
 * A slash-token: a `/word` at the start of the line or after whitespace.
 *
 * Every one of them in a command line is ruled on, not just the first, because the first is
 * not the only one that runs. `/loop 5m /clear` is a `/loop` request by its leading token and
 * a repeating `/clear` by its effect, and a check that read only the head would let the rule's
 * plainest refusal through the middle of its plainest allowance.
 *
 * It over-matches a path -- `/usr/bin/x` reads as a `/usr` token -- and that is left alone.
 * The consequence is a refusal with a reason naming `/usr`, which is a bad message about a
 * safe outcome; the alternative is a matcher clever enough to be wrong in the other direction.
 */
const SLASH_TOKEN = /(?:^|\s)(\/[A-Za-z][\w:-]*)/g

/** What the policy says about a line the advisor asked for. */
export type CommandRuling =
  | { verdict: 'allowed'; command: string; line: string; reason: string }
  | { verdict: 'refused'; command: string | undefined; line: string; reason: string }

/**
 * Rule on one `COMMAND:` line against an agent's policy.
 *
 * Fails closed in all five ways it can fail -- no policy at all, a transport with no composer,
 * no slash command in the line, no entry for the command, or an entry that refuses -- and says
 * which. "Nobody read this CLI", "this seat has nowhere to type it" and "this verb is
 * forbidden" are the same OUTCOME and three different problems, and a caller that reported
 * them identically would make two of them permanently invisible.
 */
export function ruleOnCommand(policy: CommandPolicy | undefined, line: string): CommandRuling {
  const text = line.trim()
  if (!policy) {
    return {
      verdict: 'refused',
      command: undefined,
      line: text,
      reason: 'no command policy has been declared for this agent, so no command is permitted to it',
    }
  }
  if (policy.kind === 'unsupported') {
    return { verdict: 'refused', command: undefined, line: text, reason: policy.reason }
  }

  const tokens = [...text.matchAll(SLASH_TOKEN)].map((m) => m[1] as string)
  if (tokens.length === 0) {
    return {
      verdict: 'refused',
      command: undefined,
      line: text,
      reason: 'not a slash command: nothing in the line is a command this could be a request for',
    }
  }

  const declared = new Map(policy.commands.map((c) => [c.command.toLowerCase(), c] as const))
  const head = tokens[0] as string
  for (const token of tokens) {
    const entry: CommandDeclaration | undefined = declared.get(token.toLowerCase())
    if (!entry) {
      return {
        verdict: 'refused',
        command: token,
        line: text,
        reason: `${token} is not declared in this agent’s command policy, and an undeclared command is refused`,
      }
    }
    if (entry.disposition === 'refused') {
      return { verdict: 'refused', command: token, line: text, reason: entry.reason }
    }
  }

  const headEntry = declared.get(head.toLowerCase()) as CommandDeclaration
  return { verdict: 'allowed', command: headEntry.command, line: text, reason: headEntry.reason }
}
