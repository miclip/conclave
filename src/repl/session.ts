/**
 * The REPL.
 *
 * A **client** of `RunHandle`, and deliberately nothing more. Every lifecycle transition —
 * pause, continue, rotate, constrain, abort — already exists as a method on the handle,
 * tested offline and exercised live. If any of it lived here instead, this console would be
 * the only thing able to drive a session and every other caller would reimplement it.
 *
 * So this file contains no policy. It renders what the relay reports, reads a line, and
 * calls one method. That is the whole design.
 *
 * It uses `settled()` and never `result()`. A caller holding `result()` while separately
 * driving pauses is exactly the case the unsatisfiable-wait guard rejects — see `run.ts`.
 *
 * Two things it shows that the non-interactive `conclave relay` cannot:
 *
 *   - participant ACTIVITY between an instruction and the report that answers it, which is
 *     the entire duration of the work and is otherwise silent (§5c, the intervention gap).
 *   - pauses as decision points rather than as the end of the run.
 *
 * It does not close the intervention gap. Neither child ingests input mid-turn, so a line
 * typed against activity seen here is still delivered at the next turn boundary, where it
 * reads as context for the NEXT action. Seeing sooner is not intervening sooner, and the
 * prompt says so rather than implying otherwise.
 */

import { describeTool } from '../relay/subagents.ts'
import { formatGoalFindings, lintGoal } from '../relay/goalLint.ts'
import { type Ceilings, effectiveCeilings, preflightRefusals } from '../relay/guardrails.ts'
import { createWriteStream, existsSync, realpathSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { Writable } from 'node:stream'
import { clearLine, createInterface, cursorTo, type Interface } from 'node:readline'
import { suggest } from './complete.ts'
import { Screen } from './screen.ts'
import { banner, bold, colorFor, dim, elapsedSince, grey, markdown, Progress, releaseTitleSequence, rule, setColor, speakerColor, summaryLine, titleSequence, yellow } from './render.ts'
import type { AgentEvent } from '../contract/session.ts'
import { defaultRegistry } from '../registry/builtin.ts'
import type { CheckSpec } from '../rotation/record.ts'
import type { AgentRegistry } from '../registry/registry.ts'
import type { ParticipantSpec } from '../registry/types.ts'
import { boundOf, implementerSpecsFor, Relay, reviewerSpecFor, type SeatRequest } from '../relay/relay.ts'
import type { RelayMessage } from '../relay/message.ts'
import type { RunHandle, RunPause } from '../relay/run.ts'
import { ensureCodexHooksTrusted } from '../deployment/ensureTrust.ts'
import { AGENT_KINDS, installConfig, type AgentKind } from '../config/install.ts'
import { CONFIG_RELATIVE, launchArgsFor, permissionModeFor, readProjectConfig } from '../config/project.ts'

/**
 * A role can be filled by an agent this installer knows nothing about — the registry is
 * open. Such an agent simply gets no registration, which is honest: Conclave has no
 * template for a CLI it has never heard of, and inventing one would be worse than
 * leaving the operator to wire it up.
 */
function isAgentKind(id: string): id is AgentKind {
  return (AGENT_KINDS as string[]).includes(id)
}

/**
 * Run something slow with the console's own "still working" line.
 *
 * Setup steps can outlast a turn — trusting Codex waits on a real TUI for the better part
 * of a minute — and a console that prints nothing for that long is indistinguishable from
 * one that has hung. `Progress` already owns how "still working" looks, so this borrows it
 * rather than inventing a second dialect for the same idea.
 *
 * `inPlace` redraws one line instead of appending five. The objection `Progress` documents
 * at length — that an in-place line and readline both own the last row of the terminal, and
 * whichever writes last strands the other — does not apply HERE: this runs during setup,
 * before readline is constructed, so nothing else is writing. Five near-identical lines
 * differing only in their elapsed time read as a stuck loop, which is the opposite of what
 * a heartbeat is for.
 *
 * It is gated on the terminal because the escape codes need one. A piped or recorded run
 * keeps the appended lines rather than losing progress altogether — the mistake `Progress`
 * calls out about `enabled`.
 *
 * The interval is unref'd: a pending heartbeat must never be the reason the process stays
 * alive, and it is cleared on the failure path as well as the success one.
 */
export async function withHeartbeat<T>(
  out: NodeJS.WritableStream,
  label: string,
  detail: string,
  work: () => Promise<T>,
  { inPlace = false, everyMs = 5_000 }: { inPlace?: boolean; everyMs?: number } = {},
): Promise<T> {
  const progress = new Progress(out, true, everyMs)
  progress.start(label)
  progress.note(label, detail)
  // Faster than the appended cadence, and it can be: a redraw costs one line however often
  // it happens, so the spinner is free to actually move. A motionless line is the thing an
  // operator reads as a hang.
  const beat = inPlace
    ? setInterval(() => {
        progress.tick()
        out.write(`\r\x1b[2K  ${progress.line(dim)}`)
      }, 120)
    : setInterval(() => progress.activity(label, dim, detail), 1_000)
  beat.unref()
  try {
    return await work()
  } finally {
    clearInterval(beat)
    // Erased, so the result that follows starts on a clean row rather than overwriting a
    // half-drawn spinner. The appended path has nothing to erase: it never goes back.
    if (inPlace) out.write('\r\x1b[2K')
    progress.done(label)
  }
}
import { activeTurn, describeActiveTurn } from '../outcomes/activeTurn.ts'
import { describeLiveness, sampleLiveness, type ChildLiveness } from '../outcomes/liveness.ts'
import { version } from '../version.ts'
import { guard } from '../workspace/sessionLock.ts'
import { newSessionId, projectRootFor, recordSession } from '../workspace/sessionRecord.ts'
import { RunLogWriter, readRunLog, runLogExists } from '../relay/resume.ts'

export interface SessionOptions {
  cwd: string
  /**
   * Optional. Without one the console starts and waits: the first thing typed becomes the
   * goal and starts the run.
   *
   * Requiring it up front assumed a session is a task handed over complete, which is not
   * how anyone actually arrives at one — you open the console, then work out what you want.
   */
  goal?: string | undefined
  lead: string
  implementer: string
  /**
   * Every implementer seat, when the operator named the seat list with `--implementers`: its
   * agent, and the launch arguments typed for that seat alone. Absent is the default and must
   * stay behaviourless.
   *
   * Requests rather than specs, because seat construction belongs to one place: `runSession`
   * builds the specs with `implementerSpecsFor`, exactly as the relay CLI does, so `seatIdFor`
   * is not applied on both sides of this wire and cannot disagree with itself. The first entry
   * is the lead implementer and equals `implementer`; the CLI refuses the invocation where they
   * disagree rather than passing a contradiction through.
   *
   * `SeatRequest[]` rather than `string[]`, which it was until per-seat launch arguments existed
   * (#77): the console front-end is the one that hands over a LIST and lets `runSession` build
   * the specs, so a bare agent list here is a wire on which each seat's own arguments have
   * nowhere to be. They would have had to travel as a second parallel list, correlated by index
   * with this one -- and a pairing that exists only as two array positions is one a single
   * dropped entry silently reassigns.
   *
   * A console run given none is the run it was before this field existed: no `implementers` key
   * reaches `Relay.start`, so `implementerSeats` returns `[implementer]` by the expression it
   * always used (D1).
   */
  implementers?: SeatRequest[] | undefined
  /**
   * Extra launch arguments per seat, e.g. `['-m', 'opencode/kimi-k2.6']`.
   *
   * Required rather than cosmetic for any agent that selects its model per invocation: an
   * `opencode` participant with no model pinned does not fail, it HANGS -- see issue #23.
   * Wiring this into `relay` and not here is the mistake this codebase has made four times.
   */
  leadArgs?: string[] | undefined
  implementerArgs?: string[] | undefined
  /**
   * The reviewer seat's agent, when `--reviewer` named one (#72). Absent is the default and
   * must stay behaviourless: no `reviewer` key reaches `Relay.start` at all, built through
   * the same `reviewerSpecFor` the relay CLI uses.
   */
  reviewer?: string | undefined
  reviewerArgs?: string[] | undefined
  /**
   * The `--rounds` flag, which populates `RelayOptions.maxAdvisorTurns`.
   *
   * The flag keeps its spelling because operators and scripts already type it; only the relay
   * option it feeds was renamed, and the value means the same thing on both sides of that wire.
   */
  rounds: number
  /**
   * Verification commands. A bare string is `required`; pass `{command, relevance}` for a
   * check that should run and be reported without gating a transfer.
   *
   * Two stations read them (#80): what a replacement must reproduce, and — with more than
   * one seat — what the MERGED tree must pass after every merge. One console run with one
   * seat is unaffected by the second, which has no merge to check.
   */
  checks: CheckSpec[]
  /**
   * Who is answering escalations.
   *
   * Existed on `relay` and on nothing else, which made the pair actively misleading: the
   * ONLY front-end that advertised an agent operator was the one that ends the run at every
   * pause, and the only front-end that holds a pause open had no way to say a machine was
   * driving. An agent that read the flags and picked `relay --operator agent` chose exactly
   * wrong, and the run told it so four times -- "Nobody is attending this run, so it ends
   * here" -- while the flag it had passed claimed somebody was.
   *
   * Wiring a capability into one front-end and not the other is the mistake this codebase
   * has now made seven times.
   */
  operator?: 'human' | 'agent' | undefined
  /**
   * Start even outside a git repository.
   *
   * `relay` has refused this since it was written; the console never checked, and the
   * divergence was declared UNRESOLVED on the grounds that the console does not diff the
   * tree at start-up. It runs the SAME participants, which is what matters: a session in
   * `~/workspace/earthquakes` -- no `.git` at all -- had its implementer rewrite `app.js`
   * wholesale, and the flag it carried says nothing but its own context held the prior
   * version. Attribution and rotation are meaningless there, and so is undo.
   */
  force?: boolean | undefined
  /**
   * The absolute per-turn deadline handed to each adapter's watchdog.
   *
   * The CLI has parsed `--turn-timeout` into this since it was written and the console never
   * had a field to receive it: `bin/conclave.ts` built `{ turnWatchdogMs }` inside a
   * conditional spread, which slips past TypeScript's excess-property check, so it was
   * constructed and dropped. The flag has never once worked.
   *
   * Found by a conclave session reading further than I did. This morning I declared it a
   * session-only capability that `relay` lacked -- having read the CLI, seen the flag, and
   * believed it. The parity guard compares which flags EXIST, not whether they arrive
   * anywhere, so it agreed with me.
   */
  turnWatchdogMs?: number | undefined
  /**
   * Resource ceilings for the run: wall clock, total turns, queue depth, concurrent seats.
   *
   * Console-side for the first time, and on today's merits rather than N>1's. `--operator
   * agent` already makes a console run unattended, and an unattended console run had no
   * ceiling of ANY kind -- the assumption that the console could rely on a human noticing a
   * run had gone long stopped being true the day that flag shipped, not at some future N.
   *
   * Passed to `Relay.start` unchanged. No default, no clamping, no console-specific
   * reinterpretation: a ceiling that meant something different depending on which command
   * started the run would be worse than not having one, because the operator would have to
   * know which. A session given none behaves exactly as it did before this existed.
   */
  ceilings?: Ceilings | undefined
  /**
   * How long a turn's transcript is given to catch up with the hook that ended it, and how
   * much longer an EMPTY report buys before it is treated as lost. See `Relay#exchange`.
   *
   * Not remotely front-end specific: the transcript lags a long turn the same way whoever is
   * watching. They existed on `relay` alone, so the console had no way to widen the window
   * that #39 was about -- on the front-end where the same empty report costs a pause rather
   * than a whole run, and is therefore the one you would want to reproduce it on.
   */
  transcriptSettleMs?: number | undefined
  transcriptSalvageMs?: number | undefined
  /**
   * A routing log to replay into both seats, continuing a run rather than restarting it.
   *
   * The console had neither half of this: it replayed nothing, and it RECORDED nothing, so a
   * console run that crashed after three hours left no resumable account of itself while an
   * unattended one did. The console is the front-end you leave running.
   *
   * And it is the better place to resume into. `relay` ends at every pause point, so a
   * resumed run that hits one immediately ends again; here it is held open and you answer it.
   */
  resume?: string | undefined
  /**
   * Where to write the routing log. Defaults to `.conclave/runs/session-<started>.ndjson`.
   *
   * Distinct from `record`, which tees the RENDERED bytes for inspecting a display fault.
   * This is the messages, which is what a resume needs.
   */
  runLog?: string | undefined
  /**
   * Streams for testing; defaults to the process's own.
   *
   * Explicitly `| undefined`, like most of this interface, so a caller can pass the field
   * through unconditionally. Under `exactOptionalPropertyTypes` the alternative is a
   * conditional spread at every call site -- and a spread is not excess-property checked,
   * so a mistyped key in one compiles and is silently dropped. That is how
   * `turnWatchdogMs` above went unwired for its whole life.
   */
  input?: NodeJS.ReadableStream | undefined
  output?: NodeJS.WritableStream | undefined
  /** Injected for testing. Production uses the built-in registry. */
  registry?: AgentRegistry | undefined
  /**
   * Injected for testing the console's child-liveness guard.
   *
   * Production samples the actual child process; a fake that has no child cannot exercise
   * the path without this seam.
   */
  liveness?: (pid: number) => Promise<ChildLiveness>
  /** Shown in the banner. */
  version?: string
  /** How often to print a progress line per participant. Default 10s. */
  progressEveryMs?: number
  /**
   * Tee every byte written to the terminal, escape codes included, to this file.
   *
   * Rendering faults live in the bytes. Three of them were diagnosed from screenshots,
   * which cannot show whether a line was erased or merely scrolled past — a recording can,
   * and can be asserted over.
   */
  record?: string
}

/** Slash commands, for the suggestion row. Kept beside HELP so they cannot drift apart. */
export const COMMANDS = [
  '/pause',
  '/continue',
  '/wait',
  '/rotate',
  '/abort',
  '/allow',
  '/deny',
  '/state',
  '/log',
  '/queue',
  '/audit',
  '/help',
  '/exit',
]

/**
 * A line that opens a multi-line message: NOTHING, or one address prefix, then `<<TAG`.
 *
 * Deliberately not "any line ending in `<<TAG`". The head is enumerated -- empty, `>advisor`,
 * `>implementer`, `>both` -- because the alternative silently reinterprets input that is
 * already correct today. `/rotate the seat is stuck <<HERE` is a rotate reason and
 * `>advisor compare a<<b` is a message about C++; under a permissive rule both open a block
 * instead, and the operator's next several lines vanish into it with the console showing
 * nothing routed. Every form that is framing has to be a form nobody writes by accident,
 * which is what makes the framing explicit rather than a guess.
 *
 * Module scope so it cannot land in the temporal dead zone of the console's own startup;
 * see `block` in `runSession`.
 */
const HEREDOC_OPEN = /^(|>advisor|>implementer|>both)[ \t]*<<([A-Za-z_][A-Za-z0-9_]*)[ \t]*$/

/**
 * What `/help` writes, verbatim.
 *
 * Exported for the same reason `COMMANDS` above it is: a test asserts that the help describes
 * behaviour an operator would otherwise be surprised by, and asserting on the string the console
 * actually writes is the only version of that claim worth making. Nothing asserted either help
 * surface before #75, which is how `/rotate [reason]` came to be documented as optional and
 * unconditional while it was neither.
 */
export const HELP = `
  <text>                 to BOTH, at human rank — the default, no prefix needed
  >advisor <text>        to the advisor only — the implementer will not see it
  >implementer <text>    to the implementer only — the advisor will not see it
  >both <text>           the same as no prefix; spelled out so the menu can offer it
  @src/relay/relay.ts    a path, anywhere in the line. Tab completes both sigils.

  They compose:  >advisor read @src/relay/relay.ts and tell me what it settles

  <<EOF                  a message that spans lines. Everything up to a line reading
                         exactly EOF is ONE message, blank lines and all. Any word
                         works as the tag:

                           >implementer <<EOF
                           Answered: make it opt-in.

                           Existing drivers write bare lines today.
                           EOF

                         Only <<TAG on its own or after >advisor, >implementer or
                         >both opens one — so a message or a command that happens to
                         end in <<something still means what it always did. Without
                         it a line is a message, which is what an answer of several
                         paragraphs written to stdin needs to know.

  With a run going, an addressed line is QUEUED and delivered at the next turn
  boundary. With no run, it is asked directly and you wait for the answer — the
  participants are still alive between runs, which is where the loose ends live:
  start the server so I can try it, explain that change, tidy this up.

  Paths are references, not inlined. Both participants share this directory and
  open the file themselves, and @path means the same to their own CLIs — so the
  reference survives being forwarded, which inlined text would not.

  /pause                 pause at the next advisor-turn boundary
  /continue [message]    resume from a pause. Any text is DELIVERED first, at human rank,
                         exactly as typing it on its own would — so answering and deciding
                         are one line. Typing the message alone does the same thing.
  /continue force        resume even though a child reads mid-turn. The whole word and
                         nothing after it; anything else is a message, not an override.
  /rotate [reason]       replace the implementer seat this pause is about, carrying a handoff
                         forward. A reason is REQUIRED and becomes the record — except at a
                         rotation candidate, where accepting it is agreement with the proxy,
                         so the record keeps the PROXY's words and yours is not kept (#75).
                         The console says which it did before the transaction starts.
  /abort [reason]        end the run, and stay here for the next one

  /allow [who]           answer a participant stopped at a permission prompt
  /deny  [who]           refuse it. The name is only needed if both are waiting.

  /state                 run state, participants, pending pause
  /log [n]               last n routing entries (default 20)
  /queue                 what you have typed that has not been delivered yet
  /audit                 restricted messages: who was informed, who was excluded
  /help                  this
  /exit                  leave, stopping the run and the participants (or Ctrl-C)
`

/** One line per event. Verbose enough to see progress, quiet enough to read the prose. */
function renderActivity(participant: string, e: AgentEvent): string | undefined {
  switch (e.type) {
    // No `tool_use` arm: it is handled before `renderActivity` is reached, in both the
    // pinned-footer and the fallback paths. An arm here would be dead code that looks like
    // the place tool rendering lives.
    case 'permission_requested':
      // Naming the answer at the moment the question appears. It read as a status —
      // something being waited out — when it is the one event in a turn that cannot
      // proceed without the operator.
      return `    ! ${participant} needs a permission decision for ${e.tool} — /allow or /deny`
    case 'revision':
      return `    ~ ${participant} transcript revised (${e.reason})`
    case 'error':
      return `    ! ${participant} ${e.message}`
    default:
      return undefined
  }
}

/**
 * One message.
 *
 * `human (human)` was the old header — the rank repeated the name, and the goal was printed
 * again immediately after the shell had already echoed it. Speakers are named once, in a
 * stable colour, and the body is rendered rather than dumped.
 */
function renderMessage(m: RelayMessage, width: number): string {
  // A note that withdraws the pause currently in front of the operator, in the same yellow
  // `~` as `renderPause` gives a pause that was already superseded when it was printed.
  // Rendered as grey it was indistinguishable from `implementer turn: timed_out` two lines
  // above it, which is the line it exists to contradict.
  if (m.supersession) return `\n  ${yellow('~')} ${m.text}`
  if (m.visibility === 'internal') return grey(`  ${m.text}`)
  const colour = speakerColor(m.from, m.fromRank)
  // The name alone when it already carries the rank; both only when they differ.
  const who = m.from === m.fromRank ? (m.fromRank === 'human' ? 'you' : m.from) : m.from
  // No `withheld from …` suffix. `→ implementer` already says who it went to, and on a
  // two-participant run the exclusion is the arithmetic — naming it restates the header in
  // longer words on every restricted line. It remains in `/audit`, which is where a
  // question about who was excluded is actually asked, and in the relay's own record.
  // An unaddressed message FROM a participant is going to the human — that is what
  // `relay.ask` records between runs. `(recorded only)` is right for the orchestrator's
  // own entries and wrong here: the operator asked a question and this is the answer.
  const to = m.to.length
    ? dim(` → ${m.to.join(', ')}`)
    : dim(m.fromRank === 'human' ? ' → (recorded only)' : ' → you')
  // On the message, because that is what the reader is about to believe. It was a dim line
  // ABOVE the block, which reads as background next to a report that looks complete.
  const unsettled = m.unsettled ? yellow('  ~ captured before the transcript settled') : ''
  return `\n${colour('●')} ${bold(who)}${to}${unsettled}\n${markdown(m.text, { width })}`
}

function renderPause(p: RunPause, width: number): string {
  const lines = ['', `${yellow('●')} ${bold('paused')} ${dim(p.reason)}`, markdown(p.detail, { width })]
  if (p.evidence.length > 0) {
    lines.push('')
    for (const e of p.evidence) lines.push(grey(`  ${e}`))
  }
  // A verdict already withdrawn before the pause was printed. The commoner case — withdrawn
  // while the operator is reading — arrives later as an orchestrator note, because this
  // block has already been written to a terminal and cannot be taken back.
  if (p.superseded) lines.push('', `  ${yellow('~')} ${p.superseded.note}`)
  // `constrain` is not a command — you constrain by typing. Offering it as one sent people
  // looking for a slash command that does not exist.
  const commands = p.options.filter((o) => o !== 'constrain').map((o) => `/${o}`)
  // The combined form, named where the menu is. A menu that lists `/continue` above "or type
  // a message" reads as two exclusive choices, and an operator with something to say who
  // picks the command loses the saying of it. `/continue <message>` is both, so the line that
  // offers the two separately is the line that has to admit they compose.
  lines.push('', `  ${dim(commands.join('   '))}   ${dim('or type a message — /continue <message> does both')}`, '')
  return lines.join('\n')
}

/**
 * Which children `/continue` samples for liveness, read off the pause's SCOPE.
 *
 * The scope is the pause's own answer to "what does this stop" (`src/relay/resolution.ts:190`),
 * and it is the only field here entitled to name a seat: a `participant` scope names the one
 * seat whose continuation would require making the unresolved decision, so that seat is the
 * whole question and every other seat is somebody else's turn.
 *
 * This used to read `pause.verdictOf.participant` instead, and that field is narrower than it
 * looks: it is set at exactly two halt sites, both `turn_incomplete`
 * (`src/relay/relay.ts:5046` and `src/relay/relay.ts:5430`). So FOUR of the five seat-scoped
 * reasons -- `rotation_candidate`, `implementer_unanswered`, `merge_blocked`, `review_blocked`
 * -- named a seat in their scope and were sampled by rank anyway, because the field the guard
 * read was empty. The scope is the field that is always populated, which is the other half of
 * the reason for reading it.
 *
 * There is NO fallback, and that is the change. A `conclave` or `workstream` scope samples
 * NOBODY rather than scanning for participants by rank. A rank scan answers a question nobody
 * asked: it takes a pause that is about the run, or about one workstream, and re-points it at
 * whichever children happen to be implementers -- so at N>1 an unrelated seat mid-turn refuses
 * a resumption that has nothing to do with it, and the operator is told to wait for a seat the
 * pause never mentioned. The rank fallback's own comment argued it was right "only because
 * there is one of them", which is an argument for deriving the seat from the pause instead of
 * from a rank. Worse than useless on one of them: resuming an `advisor_escalated` pause sends
 * to the ADVISOR (`src/relay/relay.ts:5145`), so the fallback measured children that were not
 * about to be sent to at all.
 *
 * What that gives up, stated rather than discovered: the `advisor_escalated` halt raised when a
 * seat's turn completed and its report could not be read (`src/relay/relay.ts:5342-5344`) is
 * conclave-scoped by design -- "the reason names who is being asked to take it, and the scope
 * follows the reason" -- yet the thing an operator wants to know there is whether THAT seat's
 * child is still writing. Under the rank fallback that seat was sampled at N=1 by coincidence
 * of being the only implementer. It is not sampled now. The pause still carries its own
 * liveness EVIDENCE from the halt site (`src/relay/relay.ts:5354-5356`), which is what the operator
 * reads;
 * what is gone is a refusal derived from a rank scan. Narrowing that halt's scope, if the
 * refusal is wanted back, is a change to the halt site rather than to this guard.
 *
 * Generic over the participant so the rule can be tested without constructing one.
 */
export function seatsToSampleAtPause<T extends { id: string }>(
  pause: RunPause | undefined,
  participants: readonly T[],
): T[] {
  // No pause is no question. Unreachable from `resumeRun`, which returns unless the run is
  // paused, and an empty sample is the honest answer rather than a rank scan's guess.
  const scope = pause?.resolution.scope
  if (scope?.kind !== 'participant') return []
  // Filter rather than find: an id that matches nothing -- a seat rotated out from under the
  // pause -- samples nothing, which is what "no reading" means everywhere else in this guard.
  return participants.filter((p) => p.id === scope.participantId)
}

export async function runSession(opts: SessionOptions): Promise<number> {
  const target = opts.output ?? process.stdout
  const tee = opts.record ? createWriteStream(opts.record) : undefined
  const out: NodeJS.WritableStream = tee
    ? new Writable({
        write(chunk, _enc, cb) {
          tee.write(chunk)
          target.write(chunk)
          cb()
        },
      })
    : target
  const width = Math.min(100, (target as NodeJS.WriteStream).columns ?? 100)
  // Colour follows the real terminal, not the tee: a recording of a colourless session
  // would show none of the rendering it was made to inspect.
  setColor(colorFor(target as NodeJS.WriteStream))
  // Whether a line can be redrawn in place. The real terminal decides, not the tee: a
  // recorded run still shows the redraws the operator saw, and a run piped to a file gets
  // the appended form because there is no cursor to move. Distinct from `colorFor`, which
  // NO_COLOR can switch off while the cursor still works, and from `interactive` below,
  // which is about stdin.
  const liveTerminal = (target as NodeJS.WriteStream).isTTY === true
  /**
   * The tab and window title, tracking what the session wants from the operator.
   *
   * Written to the real terminal rather than through the tee: a title is a property of the
   * window, so a recording that replayed one would retitle whatever window was watching it.
   * That is the opposite of the heartbeat, which IS the transcript and belongs in a
   * recording.
   */
  let currentGoal: string | undefined = opts.goal
  const title = (state: string) => {
    if (liveTerminal) target.write(titleSequence(state, currentGoal ?? basename(opts.cwd)))
  }
  const interactive =
    (opts.input ?? process.stdin) === process.stdin && process.stdin.isTTY === true
  let rl: Interface | undefined
  let screen: Screen | undefined
  /**
   * The open `<<TAG` block, if a line has started one. Declared HERE, with the console's
   * other state, and not beside the `submit` that uses it.
   *
   * `submit` is a hoisted function and the screen is handed it as `onLine` before
   * `screen.open()` — which awaits a cursor-position reply from the terminal, so it is a
   * real suspension with a live keyboard behind it. State declared next to `submit`, a
   * few hundred lines below, is in its temporal dead zone for exactly that window: a key
   * pressed while the console is opening threw `Cannot access 'block' before
   * initialization` out of the keypress handler and took the console down with it. Caught
   * by the pty suite, which types the instant the banner appears.
   */
  let block: { head: string; tag: string; lines: string[] } | undefined
  /**
   * A `/rotate` waiting on the reason its operator did not type. Declared beside `block` for the
   * same temporal-dead-zone reason, and consumed in the same place.
   *
   * ## Why the console asks instead of guessing
   *
   * Rotation was built as recovery and is being used as an instrument: replacing a seat so a
   * fresh reader applies a just-committed criterion is a good reason to rotate and is
   * methodologically UNRELATED to degradation. Until #75 the record could not tell those apart,
   * because a bare `/rotate` inherited whatever pause happened to be on screen -- and a
   * compaction generation is attached to every long session whether or not it prompted anything.
   * So the methodological rotation was recorded in the proxy's words, and #10's dataset filled
   * with rotations that had nothing to do with degradation.
   *
   * The prompt is scoped to exactly where the record would otherwise be a fiction. At a
   * `rotation_candidate` pause about this seat the proxy IS what spoke, agreeing with it is the
   * whole of the operator's contribution, and `run.rotateImplementer()` carries the pause's own
   * detail -- so nothing is asked and the common case costs nothing.
   *
   * Held rather than refused, because a refusal makes the operator retype the command; this
   * takes their next line as the answer. A line beginning `/` cancels instead of becoming the
   * reason: an operator who changes their mind at the prompt must not have `/abort` recorded as
   * why they rotated.
   */
  let awaitingRotateReason = false
  // Cleared by `leave`, alongside the screen it draws to: an interval still firing after
  // the scrolling region is gone would write over whatever the operator ran next.
  let stopAnimation: (() => void) | undefined
  /**
   * Participants with an out-of-run question in flight.
   *
   * A SET, not a single flag. A session can only run one turn at a time, so a second
   * question to the same participant has to wait — but the participants are independent,
   * and asking the implementer to start the server should not stop you asking the advisor
   * to look at something while it does. The first version serialised across everyone and
   * turned two unrelated questions into a queue.
   */
  const asking = new Set<string>()
  /** Resolves when an interactive console closes. */
  let closed: (() => void) | undefined

  /**
   * Write a line without eating what the operator is halfway through typing.
   *
   * Activity arrives asynchronously while readline is holding a partial line, so a bare
   * `out.write` interleaves with it and the typed text is visually destroyed. Clearing the
   * current line, writing, and re-prompting with `preserveCursor` redraws the prompt AND
   * the buffer, which is what makes this usable rather than merely functional.
   */
  /** Output has happened since the prompt was last drawn, so the rule needs redrawing. */
  let dirtySincePrompt = false

  const write = (s: string) => {
    if (screen) {
      // Into the scrolling region; the box is redrawn around it and never disturbed.
      screen.write(s)
      return
    }
    dirtySincePrompt = true
    if (!rl || !interactive) {
      out.write(`${s}\n`)
      return
    }
    cursorTo(out as NodeJS.WritableStream & { columns?: number }, 0)
    clearLine(out as NodeJS.WritableStream & { columns?: number }, 0)
    out.write(`${s}\n`)
    rl.prompt(true)
  }

  // A live lock means someone else's participants are working in this tree. Starting anyway
  // would overwrite their record of what was dirty before they began, which is the thing
  // that makes `conclave guard` able to tell their work from the operator's.
  // Before anything is spawned, registered or written -- the same point `relay` checks. The
  // failure being guarded is an operator who did not mean to start a run here at all, and
  // every line of setup below is work done on their behalf in a directory they may not have
  // meant to be in.
  const refusals = preflightRefusals(opts.cwd, { force: opts.force === true })
  for (const r of refusals) {
    write(`refusing to start: ${r.reason}`)
    write(`  ${r.remedy}`)
  }
  if (refusals.length > 0) return 1

  // The seat list, resolved once and read by everything below that used to read
  // `opts.implementer` and mean "the implementers". At N=1 it is one seat filled by
  // `opts.implementer` with no arguments of its own, which is the same single agent those
  // readers had.
  const seatRequests: SeatRequest[] = opts.implementers ?? [{ agent: opts.implementer, args: [] }]
  // The agents alone, for the readers that ask what is FILLING the seats -- the banner, the
  // registration set, the bypass notice. None of them can act on per-seat arguments, and a
  // launch is not built from this: `implSpecs` below is.
  const implementerAgents = seatRequests.map((s) => s.agent)

  /**
   * Everything that is an answer to the ARGV ALONE, settled before the lock is consulted.
   *
   * The ordering is #130. A live lock means someone else's participants are working in this
   * tree, and refusing to start is the right answer to an invocation that would start
   * something. `--lead nope` is not that. It is not going to launch
   * anything whatever the lock says, so a refusal naming somebody else's session answers a
   * question the operator did not ask and buries the one they did — reported as a plausible
   * flag-parsing regression, which cost a debugging afternoon before it was diagnosed three
   * layers away in `sessionLock.ts`.
   *
   * The line between the two kinds of invocation is drawn deliberately narrow, and drawing it
   * narrowly IS the fix:
   *
   *   - A TERMINAL ARGUMENT OR SPEC ERROR — an agent name no registry knows, a role that is
   *     not a model seat, a malformed `.conclave/config.json` — ends the invocation here.
   *     There was never a run for the lock to protect anything from.
   *   - EVERYTHING ELSE falls through to the refusal below, unchanged. A valid invocation
   *     that is going to start participants is precisely what the lock exists to stop, and
   *     being valid is not a reason to let it past.
   *
   * Only READING moved. `readProjectConfig` parses a file that is already there, and
   * `registry.resolve` is the registry's own "validate a spec without launching anything";
   * the hook registration, the Codex trust probe, the permission-mode write in the CLI and
   * `Relay.start`'s own `acquire` all remain below the refusal, where they were.
   */
  const projectConfig = readProjectConfig(opts.cwd)
  // Config-derived first, then per-invocation, so an explicit flag wins.
  const leadArgs = [...launchArgsFor(projectConfig, opts.lead), ...(opts.leadArgs ?? [])]
  // Per agent, as in the relay CLI: config-derived arguments are keyed by agent and two seats
  // can be filled by different ones, while `implementerArgs` is the operator's own and applies
  // to every implementer seat. Arguments belonging to ONE seat arrive on that seat's request
  // and are appended after these by `implementerSpecsFor`, so the more specific spelling wins.
  const implArgsFor = (agent: string) => [
    ...launchArgsFor(projectConfig, agent),
    ...(opts.implementerArgs ?? []),
  ]
  const implSpecs = implementerSpecsFor(seatRequests, implArgsFor)
  const reviewerSpec = reviewerSpecFor(opts.reviewer ?? '', (agent) => [
    ...launchArgsFor(projectConfig, agent),
    ...(opts.reviewerArgs ?? []),
  ])
  // Built once and handed to `Relay.start` unchanged, rather than recomposed there. The seat
  // that gets VALIDATED and the seat that gets LAUNCHED have to be the same object, or the
  // check below is a check of something else.
  const leadSpec: ParticipantSpec = {
    id: 'advisor',
    agent: opts.lead,
    role: 'advisor',
    ...(leadArgs.length > 0 ? { args: leadArgs } : {}),
  }

  const registry = opts.registry ?? defaultRegistry()
  // Every seat this invocation asked for, against the registry, before anything else happens.
  //
  // It THROWS rather than writing a refusal, and that is deliberate: `unknown agent 'nope'.
  // Registered agents: ...` is the registry's own sentence, the CLI's catch already puts it on
  // stderr, and a second copy phrased here would be a second copy to keep in step. It is also
  // the message this path produced before the fix — reached from `Relay.start` after the hooks
  // had been written and the trust probed — so nothing an operator has learned to grep for
  // changes, only how much happens on their behalf first.
  //
  // What is NOT checked here: whether each seat's CLI is on PATH, and whether it has the model
  // named. Both spawn or stat things, both are `Relay.start`'s (see `refuseMissingCommands`),
  // and `relay --dry-run` does not do them either. A spelling this file can settle from a map
  // it already holds is a different question from an installation it would have to go looking
  // for.
  for (const spec of [leadSpec, ...implSpecs, ...(reviewerSpec ? [reviewerSpec] : [])]) {
    registry.resolve(spec)
  }

  // A `--resume` naming a log that is not there is the third terminal argument error, and it
  // belongs up here with the other two rather than below the lock. It is the same shape: a
  // path that does not exist will not start existing because the tree is free, and `relay`
  // refuses it above its own dry run for exactly this reason. Reading the log stays where it
  // was -- this is the existence question, which is the part that can refuse.
  if (opts.resume && !runLogExists(opts.resume)) {
    write(`refusing to start: no run log at ${opts.resume}`)
    return 1
  }

  const existing = guard(opts.cwd)
  if (existing.live) {
    write(`refusing to start: ${existing.messages.join('\n')}`)
    return 1
  }

  write(
    banner({
      version: opts.version ?? '0.0.0',
      advisor: opts.lead,
      // Every seat's agent, comma-joined. At N=1 that is the single string it has always been;
      // at N>1 a banner naming only the first seat would be the run under-reporting itself in
      // the first thing the operator reads.
      implementer: implementerAgents.join(', '),
      cwd: opts.cwd,
      checks: opts.checks,
      // Resolved through `boundOf`, the same reader the loop uses, rather than printed straight
      // off `opts.rounds`. The two agree today because `maxAdvisorTurns: opts.rounds` is two
      // hundred lines below -- and a banner that quoted the option while the loop quoted the
      // resolution would be the same silent disagreement #119 is about, one layer up.
      ceilings: effectiveCeilings({
        advisorTurns: boundOf({ maxAdvisorTurns: opts.rounds }),
        ...(opts.ceilings ? { ceilings: opts.ceilings } : {}),
      }),
    }),
  )
  if (opts.checks.length === 0) {
    // Phrased as a possible mistake rather than a fact. A shell that split a multi-line
    // paste drops the flag entirely, which is indistinguishable from never passing one.
    write(dim('  pass --checks "npm test" to enable rotation; without it a degraded'))
    write(dim('  implementer escalates to you rather than being replaced'))
  }
  write(rule(width))

  /**
   * Register Conclave's hooks in the project being worked in, if they are not already.
   *
   * Codex loads hooks from a sidecar in the working directory and Claude from project-local
   * settings, so a project that has never hosted a session has neither, and a session there
   * would have no turn-completion signal at all. Refusing with "run config install" was
   * friction for a fix the tool already knows how to perform.
   *
   * Both files are machine-local — they contain absolute paths — which is why they are
   * gitignored and never shipped, and why every project needs this once. Rendering is
   * idempotent, so this is a no-op on every run after the first and stays silent then.
   *
   * The commands written into the target point back at Conclave's own checkout, so the
   * target needs nothing installed and no dependency on Conclave. That is what makes this
   * safe to do in a repository that is not ours.
   *
   * TRUST IS NOT TOUCHED. Codex will not run hooks in a directory it does not trust, and
   * that lives in the user's global `~/.codex/config.toml`. Writing project-local files
   * into a repository the operator just asked to run a session in is theirs to expect;
   * silently editing their global configuration is not. It is reported instead.
   */
  // Only the CLIs this session will actually launch. Both roles can be the same one, and
  // registering the other anyway would write a sidecar nobody reads and then require a
  // trust decision for it before anything reported ready.
  const agents = [...new Set([opts.lead, ...implementerAgents, ...(opts.reviewer ? [opts.reviewer] : [])])].filter(
    isAgentKind,
  )
  const installed = await installConfig({ projectRoot: opts.cwd, agents, diagnose: false })
  const changed = installed.written.filter((w) => w.changed)
  if (changed.length > 0) {
    const where = installed.selfHosted ? 'this checkout' : 'this project'
    write(dim(`  registered hooks for ${where}: ${changed.map((w) => w.label).join(', ')}`))
  }
  // Diagnosing spawns `codex app-server`, and answering Codex's prompts spawns a real
  // `codex` under a pty. An injected registry means the participants are fakes (see
  // `registry` in the options), so there is no real CLI whose deployment state could
  // affect this run — and reaching for one would make a test of the console depend on
  // Codex being installed, responsive, and in a particular trust state.
  //
  // NOT gated on having just written something. Trust is a decision in the operator's
  // global config, entirely independent of whether these project files are current: a
  // project registered yesterday, or by `config install`, is registered and untrusted
  // today. Gating on `changed` meant the second run in a new project skipped the step
  // that would have fixed it, and refused at the registry preflight instead — telling
  // the operator to go and do by hand the exact thing this block exists to do.
  //
  // `installConfig` only reaches for Codex when Codex is among `agents`, so a Claude-only
  // session still spawns nothing, and a ready project costs one silent app-server probe.
  if (opts.registry === undefined) {
    await ensureCodexHooksTrusted({
      projectRoot: opts.cwd,
      agents,
      say: (l) => write(dim(l)),
      slow: (label, detail, work) => withHeartbeat(out, label, detail, work, { inPlace: liveTerminal }),
    })
  }

  // The project config, the launch arguments and every seat spec were resolved above the lock
  // check -- read before anything is launched, and loudly, exactly as they were when they lived
  // here. A malformed config that silently meant "ask" would present as a session that stops on
  // every command for no stated reason, and it now says so before the lock does.

  // Said once, at the top, naming who. A session that never asks permission is a thing
  // the operator should be reminded of while it runs, not something they configured weeks
  // ago in a file they are not looking at.
  const bypassing = [
    permissionModeFor(projectConfig, opts.lead) === 'bypass' ? `advisor (${opts.lead})` : '',
    // Every distinct implementer agent, because a bypass is configured per agent and a seat
    // whose agent never asks permission is a thing the operator should be told about whether or
    // not it happens to be the first seat.
    ...[...new Set(implementerAgents)].map((a) =>
      permissionModeFor(projectConfig, a) === 'bypass' ? `implementer (${a})` : '',
    ),
    reviewerSpec && permissionModeFor(projectConfig, reviewerSpec.agent) === 'bypass'
      ? `reviewer (${reviewerSpec.agent})`
      : '',
  ].filter(Boolean)
  if (bypassing.length > 0) {
    write(yellow(`  permission prompts bypassed for ${bypassing.join(' and ')} — per ${CONFIG_RELATIVE}`))
  }

  // Refused above, with the other terminal argument errors. What is left here is the read.
  const prior = opts.resume ? readRunLog(opts.resume) : []
  if (prior.length > 0) {
    write(dim(`  resuming from ${opts.resume} — ${prior.length} messages replayed into both seats`))
  }
  // Recorded continuously, because a record written on exit is exactly the record a crash
  // destroys -- and a crash is one of the endings a resume exists for.
  const runLogPath =
    opts.runLog ?? join(opts.cwd, '.conclave', 'runs', `session-${Date.now()}.ndjson`)
  const runLog = new RunLogWriter(runLogPath)

  const relay = await Relay.start({
    // The same registry the seats were validated against above, not a second one built here.
    registry,
    cwd: opts.cwd,
    ...(prior.length > 0 ? { resume: prior } : {}),
    ...(opts.operator ? { operator: opts.operator } : {}),
    ...(opts.transcriptSettleMs ? { transcriptSettleMs: opts.transcriptSettleMs } : {}),
    ...(opts.transcriptSalvageMs ? { transcriptSalvageMs: opts.transcriptSalvageMs } : {}),
    ...(opts.turnWatchdogMs ? { turnWatchdogMs: opts.turnWatchdogMs } : {}),
    // Unchanged, deliberately. See `SessionOptions.ceilings`.
    ...(opts.ceilings ? { ceilings: opts.ceilings } : {}),
    // The object that was resolved above, so the seat validated and the seat launched cannot
    // be two different descriptions that merely agree today.
    lead: leadSpec,
    // `implSpecs[0]` is the object this built by hand: `seatIdFor(0)` is 'implementer' and the
    // args are the same list. The plural key is spread in only when the operator named a list,
    // so a default console run reaches `Relay.start` with exactly the options it always did.
    implementer: implSpecs[0]!,
    ...(opts.implementers ? { implementers: implSpecs } : {}),
    ...(reviewerSpec ? { reviewer: reviewerSpec } : {}),
    maxAdvisorTurns: opts.rounds,
    ...(opts.checks.length > 0 ? { rotation: { checks: opts.checks } } : {}),
    onLog: (m) => {
      // A message the operator just typed is already on screen twice over: the pinned row
      // shows the text itself while it waits, and `pendingRows` promotes it to a speaker
      // block the moment a participant takes it. Rendering it here as well put the
      // delivered block above and the queued row below — the same sentence, twice, with
      // nothing to say which was which.
      //
      // Piped input has no box, so there this is the only copy and it must still print.
      runLog.write(m)
      if (screen && injectedHere.delete(m.text)) return
      write(renderMessage(m, width))
    },
  })

  /**
   * The console's session, readable from outside it.
   *
   * Both front-ends, together — wiring a capability into one and not the other is the
   * mistake this codebase has now made six times, and the console is the one an operator is
   * most likely to have left running in another window. The id is printed with the banner
   * so it can be copied without going looking for it.
   */
  const sessionStartedAt = Date.now()
  const recording = recordSession(relay, {
    repoRoot: projectRootFor(opts.cwd),
    id: newSessionId(sessionStartedAt, process.pid),
    // A console may have no goal yet; it is filled in by `begin`. Empty rather than a
    // placeholder, so a reader can tell "not started" from "started with a vague goal".
    goal: opts.goal ?? '',
    front: 'session',
    startedAt: sessionStartedAt,
    logPath: runLogPath,
    // The same value shown in the banner, captured at startup. Recomputing at shutdown would
    // lose the commit identity in a release archive or a checkout that moves after the run.
    // Computed, never taken from the caller.
    //
    // This was `opts.version ?? '0.0.0'` -- the string the BANNER is given. The CLI happens
    // to pass the real one, so the record looked right there and was wrong everywhere else:
    // a caller that passes nothing recorded `0.0.0`, and `demo` recorded `demo`. A record
    // whose correctness depends on its caller remembering to supply the truth is the thing
    // this field exists to replace, since the whole point is telling "this build predates
    // the feature" from "the feature is broken" without asking anyone.
    build: version(),
  })
  write(dim(`  session ${recording.id} — inspect from elsewhere with: conclave status ${recording.id}`))

  // Activity as a status line that updates in place, not a scrolling list of dots. The
  // wait between an instruction and its report is the whole duration of the work, and a
  // spinner carrying the current tool says "working" without burying the prose above it.
  const progress = new Progress(out, true, opts.progressEveryMs ?? 10_000)
  const turnStartedAt = new Map<string, number>()

  /**
   * Narration streams to the human; the report goes to the other participant.
   *
   * The last delta before `turn_end` is the closing message, and that is the report. It is
   * held back rather than streamed, because the routed copy prints it a moment later under
   * `→ advisor` and printing it twice would make the routing harder to read, not easier.
   */
  const pendingNarration = new Map<string, string>()
  const narrating = new Set<string>()
  const narrate = (participant: string, rank: string, text: string) => {
    if (!text.trim()) return
    if (!narrating.has(participant)) {
      narrating.add(participant)
      write(`\n${speakerColor(participant, rank)('●')} ${bold(participant)}${dim(' → you')}`)
    }
    write(dim(markdown(text, { width })))
  }

  void (async () => {
    for await (const e of relay.observe({ replay: false })) {
      if (e.type !== 'activity') continue
      const ev = e.event
      const colour = speakerColor(e.participant, e.rank)
      if (ev.type === 'turn_start') {
        turnStartedAt.set(e.participant, Date.now())
        progress.start(e.participant)
        // A turn beginning is the moment the queue drained into it, so this is where a
        // pending message stops being pending. Without the redraw it would sit dim in the
        // box until the next unrelated event happened to repaint.
        if (screen) screen.draw()
      } else if (ev.type === 'turn_end') {
        const startedAt = turnStartedAt.get(e.participant)
        progress.done(e.participant)
        pendingNarration.delete(e.participant)
        narrating.delete(e.participant)
        if (startedAt) write(grey(`  ${e.participant} finished in ${elapsedSince(startedAt)}`))
        turnStartedAt.delete(e.participant)
      } else if (ev.type === 'tool_use') {
        // Pinned in the footer when there is one; appended only when there is nowhere to
        // pin it. Doing both put the same information in two places, and the appended copy
        // is the one that reads as a duplicate.
        // Named once, used in both paths. The fallback is the branch with NO pinned footer,
        // which is precisely where the operator has nothing else to read -- so it was the one
        // place the raw tool name still leaked through.
        const label = describeTool(ev.tool) ?? ev.tool
        progress.note(e.participant, label)
        if (screen) screen.draw()
        else progress.activity(e.participant, colour, label)
      } else if (ev.type === 'message' && ev.role === 'assistant') {
        if (screen) screen.draw()
        else progress.activity(e.participant, colour)
        const held = pendingNarration.get(e.participant)
        if (held !== undefined) narrate(e.participant, e.rank, held)
        pendingNarration.set(e.participant, ev.text)
      } else {
        const line = renderActivity(e.participant, ev)
        if (line) write(line)
      }
    }
  })()

  let run: RunHandle | undefined
  /** Resolves when a run reaches a terminal outcome. Used by the non-interactive form. */
  let runEnded: (() => void) | undefined
  const firstRunEnded = new Promise<void>((resolve) => {
    runEnded = resolve
  })
  /** Start a run. Declared here because the line handler may call it before it is read. */
  const begin = (goal: string): void => {
    // Shown, never blocking. In the console the operator is present and can retype in a
    // second, so refusing would cost more than it saves -- and unlike `relay`, a goal typed
    // here was written by the person reading the warning.
    for (const line of formatGoalFindings(lintGoal(goal))) write(dim(line))
    currentGoal = goal
    title('working')
    recording.recorder.update({ goal })
    recording.set('running')
    run = relay.start(goal)
    void supervise(run)
    refreshPrompt()
  }
  let done = false
  /** Resolvers for the pause loop, released when the operator resumes or aborts. */
  const resumed: (() => void)[] = []
  const wake = () => {
    const r = resumed.shift()
    if (r) r()
  }
  /**
   * The single way out of a pause.
   *
   * `/continue` and a typed reply both land here, so the two cannot drift: the reply path was
   * added later, and duplicating `continue()` + `wake()` is exactly how one of them ends up
   * resuming the handle without releasing the loop -- which presents as a console that
   * accepted the command and then did nothing.
   */
  const resumeRun = async (runOpts: { force?: boolean } = {}): Promise<void> => {
    if (!run || run.state !== 'paused') return
    // Refused when the child is mid-turn, because continuing SENDS -- and neither CLI accepts
    // input mid-turn, so the run ends `transport_failed`. A watchdog that says "completion is
    // uncertain" correctly warns off rotate and abort, which leaves continue looking like the
    // safe choice when it is the destructive one. Reported by an operator who lost a run to
    // exactly that, with the token counter still moving.
    //
    // WHAT IS READ HAS CHANGED (#117). This used to sample the child's CPU and refuse anything
    // that was not clearly idle. CPU is a proxy for "is this child mid-turn" and it is wrong in
    // both tails: a child blocked in `sleep` inside a Bash call is mid-turn and reads 3.2%, so
    // the guard said go and the send was fatal; and a finished child that twitched to 3.6% in a
    // three-sample window was refused, then refused again, for over an hour. Both readings were
    // accurate; the quantity was the wrong one, and no sampling schedule repairs that.
    //
    // So this reads the turn itself -- `activeTurn` over the child's own `turn_start`/`turn_end`
    // events, the same predicate the relay's peer send now uses (`Relay#awaitSendable`) and the
    // same signal the footer above draws `implementer 43s Edit` from. One question, one answer,
    // and the two callers cannot drift apart into answering it differently again.
    //
    // The CPU reading survives as COLOUR beside the refusal, because an operator deciding
    // whether to force is entitled to it. It decides nothing.
    //
    // Overridable, for the same reason it always was: a child stuck mid-turn on something
    // unrelated would otherwise be unresumable, and taking the decision away from the operator
    // is not what a pause is for.
    //
    // Read NOW, never off the pause.
    //
    // The first version matched the liveness line in `pause.evidence` -- a string captured
    // when the pause was RAISED. So the check that decides "is it safe to continue at this
    // moment" was made from a snapshot of the past, and it could never lift: a child that
    // went idle after the pause still carried an evidence line saying it was working, so
    // `/continue` refused forever and the run could not be resumed at all.
    //
    // Reported after nearly four hours of it, by an operator whose only way out was a flag
    // they had not been told about. A guard that cannot change its mind is not a guard, it
    // is a wall. Reading the turn keeps that property and sharpens it: the refusal lifts the
    // moment `turn_end` arrives, rather than when a CPU average happens to fall.
    //
    // Bypassed when the verdict the pause was raised on has been superseded by a completed
    // replacement. The pause still exists -- withdrawing the reason for it is not the same
    // as making the decision -- but a Stop hook is the authority on whether the turn ended,
    // and the replacement verdict says it did. The child may still be alive, but that no
    // longer tells us anything we need to know, so sampling it would only stall a resumption
    // the evidence model has already cleared. A withdrawal with no replacement verdict still
    // leaves the original concern in place, so sampling runs there.
    //
    // Which children to sample is the pause's own question, answered by its scope rather than
    // by a rank scan here -- see `seatsToSampleAtPause`, which is where that argument is
    // written down and where the removed rank fallback is accounted for.
    const children = seatsToSampleAtPause(run.pause, relay.participants)
    const supersededCompleted = run.pause?.superseded?.verdict?.outcome === 'completed'
    if (!runOpts.force && !supersededCompleted) {
      const sample = opts.liveness ?? sampleLiveness
      for (const child of children) {
        const turn = activeTurn(child.events)
        // No turn open is no refusal, whatever the child's CPU is doing. A high or mixed
        // reading between turns is a finished child cleaning up, and it was the reason a run
        // sat unresumable for an hour.
        if (!turn) continue
        const reason = `${child.id} is mid-turn — ${describeActiveTurn(turn)}`
        // Taken AFTER the decision, and only for the operator to read. No pid is no reading,
        // which is not a reading of idle -- and now it is not a reason to skip the seat either,
        // because the turn is what this refuses on and the turn is knowable without a pid.
        //
        // No output count belongs with this sample. It is taken fresh, here, and the count on
        // the pause was measured at another moment -- pairing them would date one fact to the
        // other's clock. This passed `0` before, which rendered as "nothing at all since the
        // prompt was sent": a claim nobody had checked, and one the reading now consults (#83).
        const pid = child.session.childPid
        let colour: ChildLiveness | undefined
        if (pid !== undefined) {
          try {
            colour = await sample(pid)
          } catch {
            // A sampling failure costs the operator a sentence, not the refusal.
          }
        }
        write(yellow(`  not continuing: ${child.id} is in the middle of a turn.`))
        write(`  ${describeActiveTurn(turn)}`)
        write(`  continuing SENDS, and neither CLI accepts input mid-turn.`)
        if (colour) write(dim(`  for colour only, deciding nothing: ${describeLiveness(colour, undefined)}`))
        write(`  wait for the turn to end, or /continue force to send anyway.`)
        // The run stays paused, so a watcher polling `state` sees no change. Record the
        // refusal so an external reader can see why `/continue` did not move the run.
        if (run.pause) {
          run.pause.refusal = { at: Date.now(), reason, ...(colour ? { liveness: colour } : {}) }
          recording.set('paused', { pause: run.pause })
        }
        return
      }
    }
    await run.continue()
    wake()
  }

  /**
   * Answer a pause with words: deliver them, then resume.
   *
   * The one path for "I have something to say AND I am deciding". A reply typed at a pause
   * takes it, and so does `/continue <message>` -- the same call, in the same order, so the
   * two forms cannot come to mean different things. They were one behaviour reachable by one
   * spelling; the second spelling exists because an operator who has just been shown a menu
   * of slash commands reaches for a slash command, and `/continue prefer the smaller change`
   * previously resumed while dropping every word of it.
   *
   * Delivered BEFORE the continue decision, exactly as the typed reply has always been. So a
   * `/continue` that the #43/#117 guard refuses still leaves the message queued and the run
   * paused -- which is the recoverable state: the operator reads the refusal, says nothing
   * further, and `/continue force` sends what they already typed. Injecting after the guard
   * would silently discard the message on the one path where the operator most wants it kept.
   *
   * Never forced. `force` is an exact word, not a prefix, so nothing that carries a message
   * can also carry the override -- see `/continue` in `handle`.
   */
  const answerPause = async (text: string): Promise<void> => {
    inject(text, 'all')
    write(dim('  delivered, and resuming — the run was paused'))
    await resumeRun()
  }

  /**
   * Perform the rotation and report it. Reached with the reason in hand, however it was got.
   *
   * Factored out of the `/rotate` branch because since #75 there are two ways in -- the reason
   * typed on the command, and the reason typed at the follow-up prompt -- and the second is a
   * separate turn through `submit`. Two copies of the reporting would eventually report two
   * different things about the same transaction.
   *
   * ## Why a reason typed at a candidate is announced as NOT kept (#75)
   *
   * `/rotate the session is wedged` at a rotation candidate is a natural thing to type, and the
   * handle records the PROXY's detail regardless: accepting a candidate is agreement, and a
   * record whose `intent` says `candidate_accepted` beside a sentence the proxy never said has
   * two fields describing different events. Dropping the sentence is right. Dropping it in
   * silence is not -- the operator watched their words go into a command and would reasonably
   * assume the record now carries them, which is exactly the false belief about what the record
   * says that #75 exists to remove. So it is said out loud, before the transaction rather than
   * after, while `/abort` is still cheap.
   */
  const rotateNow = async (reason: string): Promise<void> => {
    if (!run) return void write(dim('  nothing is running; type a goal to start'))
    if (reason.trim() && !run.rotationNeedsReason()) {
      write('  note: your reason was NOT recorded. This pause is a rotation candidate, so')
      write('  accepting it is agreement with the degradation proxy and the record carries the')
      write(`  proxy's own words: ${run.pause?.detail ?? ''}`)
      write(dim('  (a rotation you chose for your own reasons is recorded in yours — #75)'))
    }
    write('  rotating the seat this pause is about — the advisor writes a handoff, then a replacement must reproduce the record')
    const result = await run.rotateImplementer(reason || undefined)
    if (result.status === 'rotated') {
      write(`  rotated into ${result.replacement.sessionId}; still paused — /continue when ready`)
      for (const c of result.acceptance.carriedFailures) {
        write(`  carried forward failing: \`${c.command}\` exits ${c.exitCode}, as it did at handoff`)
      }
    } else {
      write(`  rolled back (${result.reason}): ${result.detail}`)
      write(`  the original is back in service; still paused — /continue when ready`)
    }
  }

  // The pause loop. `settled()` covers both a pause and the end, which is what a supervising
  // caller wants and why holding `result()` here would be wrong.
  /**
   * Drive one run to its end, pausing for the operator on the way.
   *
   * A function rather than a started promise, because a session may now begin without a
   * goal: the console comes up, waits, and the first thing typed starts the run.
   */
  const supervise = async (handle: RunHandle): Promise<void> => {
    for (;;) {
      const s = await handle.settled()
      if (s.kind === 'ended') {
        write(`\n${summaryLine('===', `run ended: ${s.outcome.reason}${s.outcome.detail ? ` — ${s.outcome.detail}` : ''}`, width)}`)
        write(summaryLine('===', `${relay.log.length} messages routed`, width))
        // The rotation summary and any carried flags, on BOTH front-ends. The console had
        // neither: a `done` carrying an unresolved caveat read as unqualified success here
        // too, and an operator who was present for the turn is not thereby guaranteed to
        // have registered a single sentence 300 lines ago.
        write(summaryLine('===', relay.rotationSummary(), width))
        // The line that makes an abnormal ending recoverable, as `relay` prints. A console
        // run ends with work in flight for the same reasons an unattended one does.
        // Label and path on separate lines, and the path NOT wrapped.
        //
        // Both were single lines carrying an absolute path, so they ran to three or four
        // times the terminal width and broke mid-path. Wrapping them with a hanging indent
        // would be worse than the break: the resume line exists to be selected and run, and
        // an indent in the middle of it is pasted along with everything else. A path on its
        // own line soft-wraps at the edge and stays copyable, which is the property that
        // matters for the one line whose entire purpose is being copied.
        // Relative to the directory the operator is standing in, when it is under it.
        //
        // The log always lives in `.conclave/runs/` inside the project, so the absolute path
        // is the project prefix repeated back at someone who is already there -- and in a
        // temp directory that prefix is sixty characters, enough to break the line whatever
        // is done about wrapping. `.conclave/runs/session-….ndjson` fits, and `--resume`
        // takes it verbatim from that directory, which is where they are.
        const shown = runLogPath.startsWith(`${opts.cwd}/`) ? relative(opts.cwd, runLogPath) : runLogPath
        write(summaryLine('===', `run log: ${shown}`, width))
        write(summaryLine('===', `resume with: conclave session "<goal>" --resume ${shown}`, width))
        for (const line of relay.flagSummary()) write(summaryLine('===', line, width))
        // The session does not end with the run. There are participants alive and a human
        // at the prompt; ending here would throw away a working session at the exact moment
        // the next instruction was about to arrive.
        run = undefined
        // The outcome by name, not just "done": a tab saying `aborted` and a tab saying
        // `completed` are the difference between glancing and going back.
        title(s.outcome.reason)
        // `starting`, not `ended`: the console outlives its run and the next instruction
        // starts another one. A status saying `ended` while a live console sits at the
        // prompt would tell a poller nobody is there.
        recording.set('starting', { outcome: s.outcome })
        runEnded?.()
        refreshPrompt()
        prompt()
        return
      }
      // The one transition the title exists for. A paused session is waiting on a decision
      // and looks, from a backgrounded tab, exactly like one still working.
      title('paused')
      recording.set('paused', { pause: s.pause })
      write(renderPause(s.pause, width))
      await new Promise<void>((resolve) => resumed.push(resolve))
      title('working')
      recording.set('running')
    }
  }

  /**
   * The prompt carries the queue depth.
   *
   * Anything typed while a turn is running is delivered at the next boundary, not now — so
   * the operator needs to see that it is stacked up somewhere. Putting it in the prompt
   * means readline redraws it for free, with no second line competing for the one the
   * status already uses.
   */
  /**
   * Messages typed but not yet taken by a participant.
   *
   * Keyed by the text rather than by recipient: one line addressed to everyone is one thing
   * the operator typed, and listing it once per recipient reported two pending messages for
   * a single sentence. The label is who has NOT taken it yet, so a broadcast that the
   * advisor picks up first visibly narrows to `→ implementer` rather than sitting there
   * looking undelivered.
   */
  const queuedFor = new Map<string, Set<string>>()

  /**
   * Text the console just injected, so `onLog` can decline to render it.
   *
   * A typed message is recorded and queued in one call, and `onLog` fires from inside the
   * record — before the text reaches the queue. So the pinned row cannot yet be consulted
   * to ask "will this be shown below anyway"; the console has to say so itself.
   *
   * The alternative, suppressing every human message, would have swallowed the GOAL, which
   * takes `relay.start` rather than this path and is never queued.
   */
  const injectedHere = new Set<string>()

  function inject(text: string, audience: Parameters<NonNullable<typeof run>['injectConstraint']>[1]) {
    if (!run) return
    injectedHere.add(text)
    return run.injectConstraint(text, audience)
  }

  // This is a render callback that WRITES: a message leaving every queue is how the console
  // learns it was delivered, and it emits the speaker block for it. Writing re-enters the
  // screen, which calls this again. That was harmless while draws were event-driven and
  // rare; the animation calls it ten times a second, so the re-entrant path is now taken
  // routinely rather than never. `queuedFor.delete` already runs before the write, so the
  // inner call cannot re-emit — this makes that a property of the code rather than of the
  // order of two statements.
  let emitting = false

  function pendingRows(): string[] {
    const live = new Map<string, Set<string>>()
    for (const { id, texts } of relay.pending()) {
      for (const t of texts) {
        const set = live.get(t) ?? new Set<string>()
        set.add(id)
        live.set(t, set)
      }
    }
    // Anything that has left every queue was delivered: write it into the transcript as a
    // TURN, in the same speaker block every participant gets. This is the whole point of
    // pinning it — a line that already scrolled past cannot stop being provisional, so the
    // provisional copy lives in the box until it can be replaced by a real one.
    //
    // Rendered as a speaker rather than as a note about a speaker, because it is one. A
    // grey `› hello — read by advisor` sat among the run's own logging and read as more
    // logging; the transition from dim-in-the-box to a full magenta `you → advisor` is what
    // makes "this was read" legible without a phrase claiming it.
    if (!emitting) {
      emitting = true
      try {
        for (const [text, recipients] of [...queuedFor]) {
          if (live.has(text)) continue
          queuedFor.delete(text)
          const colour = speakerColor('you', 'human')
          write(
            `\n${colour('●')} ${bold('you')}${dim(` → ${[...recipients].join(', ')}`)}\n` +
              markdown(text, { width }),
          )
        }
      } finally {
        emitting = false
      }
    }
    for (const [text, ids] of live) queuedFor.set(text, ids)
    return [...live].map(([text, ids]) => `→ ${[...ids].join(', ')}  ${text.split('\n')[0]}`)
  }

  /**
   * Whether this run has seats to tell apart.
   *
   * Read off the DISPATCHER rather than off `opts.implementers`, so it answers the same
   * question the status file answers and answers it from the same place. A console told by
   * its own flags that it has two seats, while the dispatcher had one, would draw a row for
   * a seat nothing could ever be dispatched to.
   */
  const multiSeat = (): boolean => relay.seats().length > 1

  /**
   * One row per implementer seat with a task in flight.
   *
   * EMPTY AT N=1, which is what keeps the default console byte-identical: with one seat the
   * status rule already names it, its elapsed time and its current tool, and a second row
   * saying the same thing is the "three places reporting the queue" failure this box was
   * built to end. At N>1 the rule cannot do the job — see `ScreenOptions.seats` — so the
   * seats move off it and onto rows of their own, one each.
   *
   * Busy rather than every seat. An idle seat is not a thing the operator is waiting on, and
   * a row that says `seat-beta idle` costs a row of transcript to report an absence. `/state`
   * lists them all, which is what the overflow line points at.
   *
   * Each row carries the seat, how long its turn has been running, and what it was asked to
   * do — first line only, because the instruction is prose and the row is a row. The screen
   * clips whatever still does not fit.
   */
  function seatRows(): string[] {
    if (!multiSeat()) return []
    const queue = new Map(relay.tasks().map((e) => [e.task.id, e]))
    const rows: string[] = []
    for (const s of relay.seats()) {
      if (s.current === undefined) continue
      const entry = queue.get(s.current)
      const startedAt = entry?.runtime.sentAt ?? turnStartedAt.get(s.seat)
      const elapsed = startedAt === undefined ? '' : ` ${dim(elapsedSince(startedAt))}`
      const head = entry?.task.instruction.split('\n')[0] ?? ''
      const what = head ? `  ${dim(`${s.current} · ${head}`)}` : `  ${dim(s.current)}`
      rows.push(`${speakerColor(s.seat, 'implementer')(s.seat)}${elapsed}${what}`)
    }
    return rows
  }

  /**
   * Ask one participant something with no run in flight, and wait for the answer.
   *
   * A run ending does not end the session: both participants are still alive, holding
   * everything they just did, until the console is closed. The loose ends are the reason
   * to stay — start the server so I can try what you built, explain that change, tidy this
   * up — and none of them is a new goal.
   *
   * Both the question and the answer are recorded, so `/log` and `/audit` see this the way
   * they see anything else said to one participant and not the other.
   */
  function askDirectly(who: string, text: string): void {
    if (asking.has(who)) {
      return void write(dim(`  ${who} is still answering; one question at a time each`))
    }
    asking.add(who)
    progress.start(who)
    progress.note(who, 'answering you')
    if (screen) screen.draw()
    void relay
      .ask(who, text)
      .catch((err: Error) => {
        write(dim(`  ${who} could not answer: ${err.message}`))
      })
      .finally(() => {
        asking.delete(who)
        progress.done(who)
        if (screen) screen.draw()
      })
  }

  /**
   * Confirm a queued message. With the box, the pinned row IS the confirmation and shows
   * the text itself — better than a sentence about it. Piped input has no box, so it still
   * gets the sentence; otherwise a scripted session would lose the fact entirely.
   */
  function queued(who: string): void {
    if (screen) return void screen.draw()
    write(`  queued for ${who} at the next exchange`)
  }

  function promptText(): string {
    // Always the chevron, and nothing else. It carried a `(2 queued)` counter until the
    // queue itself became visible directly above the box — at which point the count was the
    // third place on screen saying the same thing, and the only one that made the prompt
    // shift sideways under the cursor as messages were taken.
    return `${bold('›')} `
  }

  const refreshPrompt = () => {
    // Guarded like `prompt()`, and for a failure only the piped form shows: a run torn down
    // mid-turn leaves participants still resolving, and their events keep arriving after
    // readline has closed. Interactively the process is exiting so nothing notices;
    // in-process it threw ERR_USE_AFTER_CLOSE as an unhandled rejection, from teardown that
    // stopped reading without stopping being called.
    if (done) return
    if (screen) return void screen.draw()
    rl?.setPrompt(promptText())
  }

  /**
   * The pinned footer: one live line for whoever is working.
   *
   * Progress used to be appended to the transcript, which produced lines differing only in
   * their elapsed time — `implementer 8s · Bash`, then `20s`, then `1m08s` — and they read
   * as duplicates however correct each one was. Pinned, there is one line, always current,
   * and nothing repeats.
   */
  const status = (): string => {
    // Each participant in its OWN colour. It was hardcoded to the implementer's, which was
    // invisible while only one could ever be shown and becomes a lie once both are: two
    // names in the same colour is the one thing that would stop the operator telling the
    // advisor's work from the implementer's at a glance.
    // At N>1 the seats have rows of their own directly above the box, so they come OFF the
    // rule — otherwise every busy seat is named twice, and the rule, which is one line inlaid
    // into one row, is the copy that wraps and paints over the transcript. The advisor stays
    // here at every N: it has no seat, no row, and nowhere else to be reported.
    //
    // At N=1 no filter is passed at all, so this is the call it has always been.
    const seatIds = multiSeat() ? new Set(relay.seats().map((s) => s.seat)) : undefined
    const colour = (p: string) => speakerColor(p, p === 'advisor' ? 'advisor' : 'implementer')(p)
    const active = seatIds ? progress.line(colour, (p) => !seatIds.has(p)) : progress.line(colour)
    // Names the other door too. "Type a goal to start" was the only one offered, which is
    // why a question for one participant looked impossible rather than merely unqueued.
    const idle = !run && !active ? dim('type a goal to start, or >advisor / >implementer to ask') : ''
    // No queue count here: the pinned rows above the box show the messages themselves, and
    // a number beside them is a worse version of the same fact. It was one of three places
    // reporting the queue at once — the failure this whole box exists to stop.
    return [active, idle].filter(Boolean).join(dim('  ·  '))
  }

  /**
   * The row under the input, answering whatever is being typed.
   *
   * A static status line there was a row spent on something that rarely changes. Suggestions
   * change with every keystroke and have nowhere else to go — anywhere in the transcript and
   * they would scroll away from the thing they describe.
   */
  const hint = (): string => {
    // An open `<<TAG` block outranks both. Nothing typed into one is echoed as a message and
    // the transcript stays still, so without a row saying so the console is indistinguishable
    // from one that has stopped responding — and the way out is a word only the operator who
    // opened the block knows. It is named here on every draw rather than announced once,
    // because the announcement would have scrolled away by the third line of the answer.
    if (block) {
      return `  ${dim(`collecting a message — ${block.lines.length} line(s); close it with a line reading exactly`)} ${bold(block.tag)}`
    }
    // Same argument one case over: while this is held the next line is neither a message nor a
    // command, and a console that looks ordinary while quietly reinterpreting the keyboard is
    // one the operator finds out about by having their sentence recorded as a rotation reason.
    if (awaitingRotateReason) {
      return `  ${dim('waiting for the reason this seat is being rotated — a')} ${bold('/command')} ${dim('cancels')}`
    }
    // Only the resting reminder. Whenever there is something to choose the screen draws the
    // menu here instead, because a suggestion belongs against the keystroke that produced
    // it and anywhere in the transcript it would scroll away from it.
    const line = screen?.line ?? ''
    return line ? '' : `  ${dim('/ for commands  ·  > to address  ·  @ for a path  ·  no prefix goes to both')}`
  }

  /**
   * Separate the input area from the transcript.
   *
   * A rule drawn immediately above the prompt, and only when something has been written
   * since the last one — otherwise every keystroke would stack rules. It is not pinned to
   * the bottom of the screen: that needs the console to own the screen, which is a
   * different piece of work (see the note in render.ts).
   */
  const prompt = () => {
    if (done) return
    if (screen) return void screen.draw()
    if (dirtySincePrompt && interactive) {
      out.write(`\n${rule(width)}\n`)
      dirtySincePrompt = false
    }
    rl!.prompt()
  }

  if (interactive) {
    // The console owns the screen. readline can only draw at the cursor, which is why three
    // attempts at a pinned status line failed; see screen.ts.
    screen = new Screen({
      input: (opts.input ?? process.stdin) as NodeJS.ReadStream,
      output: target as NodeJS.WriteStream,
      prompt: promptText,
      status,
      hint,
      onLine: (raw) => submit(raw),
      suggest: (line, cursor) => suggest(line, cursor, opts.cwd, COMMANDS),
      pending: pendingRows,
      seats: seatRows,
      onInterrupt: () => onInterrupt(),
    })
    await screen.open()
    // Motion is the liveness signal, and it cannot be event-driven: a participant deep in
    // a single `Bash` call emits nothing for minutes, so an event-driven redraw left the
    // status frozen — same spinner glyph, same elapsed time — which is indistinguishable
    // from a hung session. It has to advance on its own clock or it means nothing.
    //
    // Redrawing costs a rewrite of the reserved rows, which `screen` already does on every
    // keystroke, and it stops entirely when nobody is working so an idle console is
    // perfectly still. Unref'd: an animation must never be why the process stays alive.
    const animation = setInterval(() => {
      if (!progress.line()) return
      progress.tick()
      screen!.draw()
    }, 100)
    animation.unref()
    stopAnimation = () => clearInterval(animation)
  } else {
    rl = createInterface({
      input: opts.input ?? process.stdin,
      output: out,
      prompt: `${bold('›')} `,
      // A pipe gets no line editing and no redraws: the first live run piped stdin and got
      // `[1G[0J>` escape sequences in its log because readline drew a prompt for it.
      terminal: false,
    })
  }
  prompt()

  /**
   * Ctrl-C must not orphan the children.
   *
   * Killing the process leaves two CLIs holding PTYs with nothing to reap them — the exact
   * leak that held a test process open for 26 minutes before `close('abandoned')` was
   * fixed to terminate. First interrupt aborts the run and tears down; a second gives up
   * and exits, because a teardown that itself hangs must not trap the operator.
   */
  /**
   * Put the terminal back and stop reading. Shared by the interrupt and by `/exit`, because
   * an operator who typed a command to leave has the same claim on a restored terminal as
   * one who pressed Ctrl-C, and a second way out that forgot `screen.close()` would leave
   * the scrolling region set over whatever they ran next.
   */
  const leave = () => {
    done = true
    // Given back before the screen is restored, so a tab never outlives the session still
    // claiming to be one.
    if (liveTerminal) target.write(releaseTitleSequence())
    stopAnimation?.()
    screen?.close()
    rl?.close()
    closed?.()
  }

  let interrupting = false
  const onInterrupt = () => {
    if (interrupting) {
      write('\n  second interrupt — exiting without waiting for teardown')
      process.exit(130)
    }
    interrupting = true
    write('\n  interrupt — aborting the run and stopping participants (again to force)')
    // Abort the run AND close the console. The session outliving a run is right when the
    // run ends on its own — you carry on with the next task — but an interrupt is a request
    // to leave, and aborting while staying at the prompt is not what Ctrl-C means.
    if (run) void run.abort('interrupted at the console').then(leave, leave)
    else leave()
  }
  rl?.on('SIGINT', onInterrupt)
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onInterrupt)

  /**
   * A message that spans lines, for a driver that has to write one.
   *
   * The protocol stays line-oriented and every line that works today still works: this is
   * opt-in framing, not a new default. `>implementer <<EOF` opens a block, a line that is
   * exactly `EOF` closes it, and everything between arrives as ONE message with its
   * newlines and its blank lines intact.
   *
   * Reported as #102 by an agent operator answering an `implementer_unanswered` pause --
   * the case where the answer is longest, because the seat stopped precisely to ask
   * something that needed a reasoned reply. Seven lines became seven messages, and the
   * fragmentation was not the worst of it: only the first line carried the `>implementer`
   * prefix, so the rest of a restricted answer went to everyone; and the run resumed on
   * one of the middle lines, so the tail of the answer arrived after the implementer had
   * already acted on the fragment. The message counter -- the number an external observer
   * polls to tell whether a run is progressing -- moved seven times for one answer.
   */
  function submit(raw: string): void {
    const body = raw.replace(/\r$/, '')
    // Before the block opener and before `dispatch`, because a `/rotate` waiting on its reason
    // is holding a decision the operator has already started making and every other reading of
    // this line would take it somewhere else (#75).
    //
    // A line beginning `/` CANCELS instead of becoming the reason. The alternative is recording
    // `/abort` as why a seat was rotated, and an operator who changes their mind at the prompt
    // is the likeliest person to type one -- so the command is honoured and the rotation is not
    // performed. `block` is checked first because a `<<TAG` cannot be open here: opening one
    // requires a line this branch would have consumed.
    if (awaitingRotateReason) {
      const reason = body.trim()
      awaitingRotateReason = false
      if (!reason) {
        // An empty line never reaches `dispatch` either, so this is unreachable through the
        // console and is here for a driver writing straight into `submit`. Named rather than
        // treated as an answer: nothing was stated, so nothing may be recorded as stated.
        write('  no reason given — the rotation was not performed. /rotate <why> when ready.')
        return void refreshPrompt()
      }
      if (reason.startsWith('/')) {
        write(dim('  rotation cancelled — nothing was replaced'))
        return void dispatch(reason)
      }
      return void dispatch(`/rotate ${reason}`)
    }
    if (block) {
      // EXACTLY the tag, with no trim. Inside a block every other line is content, and a
      // line of spaces is content too — trimming first would make `   EOF   ` a terminator
      // and so make the rule "the tag, roughly", which is not a rule a driver can generate
      // against. Nothing else is interpreted either: a blank line is part of the answer and
      // a line beginning `/` is text rather than a command.
      if (body === block.tag) {
        const { head, lines } = block
        block = undefined
        // Verbatim. Leading and trailing blank lines are the operator's, not noise to be
        // tidied: a block is a quotation of what they wrote, and a framing that edits its
        // own payload is one they have to think about instead of use.
        const text = lines.join('\n')
        // Empty is not a message. `>implementer` alone already answers this by asking what
        // to say, so an empty block routes to that same sentence rather than injecting
        // whitespace at human rank.
        return void dispatch(head, text.trim() ? text : '')
      }
      block.lines.push(body)
      // The hint row counts the lines as they arrive, so redraw it. Only the screen: a piped
      // driver would get a prompt per body line, which is the noise-per-fragment this change
      // exists to remove — one message earns one prompt, written when it is dispatched.
      screen?.draw()
      return
    }
    const opened = HEREDOC_OPEN.exec(body)
    if (opened) {
      block = { head: opened[1] ?? '', tag: opened[2]!, lines: [] }
      screen?.draw()
      return
    }
    dispatch(body.trim())
  }

  /**
   * @param framed the block's verbatim content, when `line` is the head of one. Its absence
   * is what keeps a legacy single line on its original path: an unframed message is still
   * split on whitespace and re-joined with single spaces, exactly as it always has been.
   */
  function dispatch(line: string, framed?: string): void {
    void (async () => {
      try {
        if (line || framed) await handle(line, framed)
      } catch (err) {
        write(`  ! ${err instanceof Error ? err.message : String(err)}`)
      }
      refreshPrompt()
      prompt()
    })()
  }
  rl?.on('line', submit)

  /**
   * Input that ended mid-block is named, not delivered and not silently dropped.
   *
   * Delivering the fragment is the one thing that cannot be done honestly here: stdin
   * closing is what ends the session, so the half-message would be racing teardown and
   * whether any of it reached a seat would depend on the timing. Saying what was buffered
   * and how to resend it is the part that is always true.
   */
  const flushOpenBlock = () => {
    if (awaitingRotateReason) {
      // The same rule as the block below, and the stronger case for it: nothing was rotated,
      // because the reason never arrived. Saying so beats leaving an operator to wonder whether
      // a seat was replaced as their session went down.
      awaitingRotateReason = false
      write('  input ended before a rotation reason was given — nothing was rotated')
    }
    if (!block) return
    const { tag, lines } = block
    block = undefined
    write(`  input ended inside <<${tag} — ${lines.length} buffered line(s) were NOT delivered`)
    write(dim(`  a block is only a message once a line reading exactly ${tag} closes it`))
  }
  rl?.on('close', flushOpenBlock)

  /**
   * @param framed a block's verbatim content, when `line` is the head that opened it.
   *
   * The two arrive separately rather than as one reconstructed string, and that is the whole
   * point: a framed message never goes through `split(/\s+/)`, so its newlines and its runs
   * of spaces survive, while an unframed line keeps the normalisation it has always had.
   * Rebuilding `${head} ${text}` and re-parsing it would have meant one path for both, and
   * the only way to make that path carry newlines was to stop collapsing whitespace for
   * every ordinary single-line message too -- a change to input that works today, made to
   * serve input that did not.
   */
  async function handle(line: string, framed?: string): Promise<void> {
    // `framed` is a head from `HEREDOC_OPEN`, which is one of four exact strings — so it is
    // the whole word by construction, and an empty head is the no-prefix form whose message
    // goes to both.
    const [word, ...restWords] = framed === undefined ? line.split(/\s+/) : [line]
    const rest = framed ?? restWords.join(' ')
    // What a message-shaped line SAYS, as opposed to the line that carried it. Identical for
    // unframed input; for a block with no prefix it is the block, not the head.
    const message = framed ?? line

    if (word === '/help') return void write(HELP)

    if (word === '/queue') {
      const q = relay.pending()
      if (q.length === 0) return void write(dim('  nothing queued'))
      for (const { id, texts } of q) {
        write(`  ${dim('→')} ${bold(id)}`)
        for (const t of texts) write(`      ${t.split('\n')[0]}`)
      }
      write(dim('  delivered at the next exchange — no child ingests input mid-turn'))
      return
    }

    if (word === '/state') {
      write(`  run: ${run ? `${run.state}${run.pause ? ` (${run.pause.reason})` : ''}` : 'not started'}`)
      if (run?.pause?.superseded) write(`  ${yellow('~')} ${run.pause.superseded.note}`)
      for (const p of relay.participants) {
        write(`  ${p.id} (${p.rank}): session ${p.session.state}, ${p.events.length} events`)
      }
      // The full seat state, which is what the box's overflow row points here for. Nothing at
      // N=1: with one seat the lines above already are the whole answer, and this command's
      // output on a default run must not change.
      if (multiSeat()) {
        const queue = new Map(relay.tasks().map((e) => [e.task.id, e]))
        for (const s of relay.seats()) {
          const entry = s.current === undefined ? undefined : queue.get(s.current)
          const task = entry ? `${entry.task.id} · ${entry.task.instruction.split('\n')[0]}` : 'no task'
          const tree = relay.worktrees?.seats.find((w) => w.seatId === s.seat)
          const branch = tree ? `, ${tree.branch}` : ''
          write(`  ${s.seat}: ${s.state}${branch} — ${task}`)
        }
      }
      return
    }

    if (word === '/log') {
      const n = Number(rest) || 20
      for (const m of relay.log.slice(-n)) write(renderMessage(m, width))
      return
    }

    if (word === '/audit') {
      const entries = relay.audit()
      if (entries.length === 0) return void write('  no restricted messages')
      for (const a of entries) {
        write(`  [${a.seq}] informed ${a.informed.join(', ')} · excluded ${a.excluded.join(', ')}`)
        write(`        ${a.text.split('\n')[0]}`)
      }
      return
    }

    if (word === '/allow' || word === '/deny') {
      const decision = word === '/allow' ? 'allow' : 'deny'
      const waiting = relay.permissionsPending()
      if (waiting.length === 0) return void write(dim('  nobody is waiting on a permission decision'))
      // The argument is only needed to disambiguate. One waiting participant is the case
      // that matters, and making the operator name it there would be ceremony for its own
      // sake — the console already told them who it was.
      const target = rest.trim() || (waiting.length === 1 ? waiting[0]!.id : '')
      if (!target) {
        const who = waiting.map((w) => `${w.id} (${w.tool})`).join(', ')
        return void write(`  ${word} needs a name — waiting: ${who}`)
      }
      void relay.decidePermission(target, decision).catch((err: Error) => {
        write(dim(`  ${err.message}`))
      })
      return
    }

    if (word === '/pause') {
      if (!run) return void write(dim('  nothing is running; type a goal to start'))
      if (run.state === 'paused') return void write('  already paused')
      write('  pausing at the next advisor-turn boundary — a turn in flight has to finish first')
      void run.requestPause('the operator asked to pause')
      return
    }

    if (word === '/continue') {
      if (!run) return void write(dim('  nothing is running; type a goal to start'))
      if (run.state !== 'paused') return void write(`  not paused (${run.state})`)
      // Trailing text is a MESSAGE, delivered at human rank and then resumed on -- the same
      // call a typed reply makes, via `answerPause`. It used to be discarded: `/continue do
      // the smaller one` resumed and the words went nowhere, with nothing said about them.
      // A pause asks a question, and the two things an operator does with a question are
      // answer it and let it go; a console that offers `/continue` beneath the question and
      // then eats the answer punishes the operator for using the menu it just drew.
      //
      // EXACTLY two forms are preserved, and `force` is one WORD rather than a prefix. The
      // ambiguity is real -- `/continue force it through` could be a forced resume with a
      // note, or a message beginning "force" -- and it is resolved toward the message,
      // because the costs are not symmetric. Reading it as a message costs a refusal the
      // operator can see and repeat past (`/continue force`), with their words already
      // queued. Reading it as a force costs a send into a live turn, which is the run-ending
      // failure #117 exists to prevent. Guessing in the direction of the destructive reading
      // to save a keystroke is not a trade this command gets to make.
      //
      // FALSIFIER, stated because it is the strongest argument against this shape: the
      // console has no general "trailing text is a message" rule and does not gain one here.
      // `/rotate <text>` and `/abort <text>` consume their text as a REASON
      // (`src/repl/session.ts:1919`, `src/repl/session.ts:1952`) and `/pause`, `/queue`, `/audit` ignore
      // whatever follows them. So an operator who learns this from `/continue` and carries
      // it to `/pause I'll be back` still loses the sentence. That inconsistency is not
      // repaired by making `/continue` a third behaviour; it is narrowed by it, and the
      // remaining commands are left alone deliberately rather than by oversight -- `/rotate`
      // and `/abort` already have a meaning for their argument that a message would displace,
      // and changing what an existing spelling does is worse than leaving one that never had
      // a meaning at all. `/continue` is the only paused-state command whose argument slot
      // was empty apart from `force`, which is what makes it the one that can take this.
      const trailing = rest.trim()
      if (trailing && trailing !== 'force') return void (await answerPause(trailing))
      await resumeRun({ force: trailing === 'force' })
      return
    }

    if (word === '/wait') {
      if (!run) return void write(dim('  nothing is running; type a goal to start'))
      if (run.state !== 'paused') return void write(`  not paused (${run.state})`)
      // Recorded rather than silent, which is the whole point. Declining to answer and
      // choosing to wait were indistinguishable: the status file said `paused` either way,
      // and so did a monitor polling it. Reported by an operator who correctly declined
      // every destructive option and had no way to say so.
      const mins = Number(rest.trim()) || 15
      const until = Date.now() + mins * 60_000
      if (!run.wait({ at: Date.now(), until })) {
        return void write('  nothing to wait on')
      }
      // Rewritten explicitly. The recorder re-serialises the live pause object on any event,
      // so an in-place change like `superseded` reaches the file on the next one -- but a
      // pause is precisely when nothing is flowing, so a decision made here would sit
      // invisible until something else happened. The one reader who needs it most is the
      // one polling from outside.
      recording.set('paused', { pause: run.pause })
      write(dim(`  waiting ${mins}m — the run stays paused and nothing is sent`))
      write(dim('  the turn may still finish; its verdict would be withdrawn and you would decide then'))
      // A deadline, so a turn that really has died is caught rather than waited on forever.
      const timer = setTimeout(() => {
        if (!run || run.state !== 'paused') return
        const p = run.pause
        write(
          p?.superseded
            ? yellow(`\n  the wait is over and the verdict was withdrawn — ${p.superseded.note}`)
            : yellow(`\n  ${mins}m elapsed and the verdict still stands. Decide, or /wait again.`),
        )
        refreshPrompt()
      }, mins * 60_000)
      timer.unref()
      return
    }

    if (word === '/rotate') {
      if (!run) return void write(dim('  nothing is running; type a goal to start'))
      if (run.state !== 'paused') return void write('  pause first: /pause, then /rotate')
      // Refused rather than attempted, naming the seat it would have replaced. Rotation targets
      // ONE implementer seat -- since #78 the seat this pause is about, which is why a pause
      // caused by the ADVISOR does not offer it: an operator who picked it from that menu got
      // silence and a spent turn.
      if (!run.pause?.options.includes('rotate')) {
        write('  rotation is not available at this pause. It replaces the IMPLEMENTER SEAT this')
        write('  pause is about, and needs --checks so a replacement can be verified against what')
        write('  the original did.')
        if (run.pause?.verdictOf) {
          write(`  this pause rests on ${run.pause.verdictOf.participant}'s turn.`)
        }
        return
      }
      // Asked for, not guessed at (#75). See `awaitingRotateReason` for why a bare `/rotate`
      // away from a rotation candidate cannot honestly borrow the pause's words, and
      // `run.rotationNeedsReason()` for the predicate -- read from the handle rather than
      // recomputed here, so the console cannot prompt about one seat and rotate another.
      if (!rest && run.rotationNeedsReason()) {
        awaitingRotateReason = true
        write('  why are you rotating this seat? One line.')
        write(dim('  this pause is not a rotation candidate, so nothing here says why — and a'))
        write(dim('  rotation you chose for your own reasons must not be recorded as one the'))
        write(dim('  degradation proxy prompted (#75). A /command instead cancels the rotation.'))
        screen?.draw()
        return
      }
      await rotateNow(rest)
      return
    }

    if (word === '/abort') {
      // Ends the RUN, not the session — participants stay up and you can start another
      // task. `/exit` is the one that ends the session. These used to be the same command
      // when nothing was running, which made "abort" mean two different things depending on
      // state the operator could not see.
      if (!run) return void write(dim('  nothing is running — /exit to leave'))
      await run.abort(rest || 'aborted by the operator')
      wake()
      return
    }

    if (word === '/exit' || word === '/quit') {
      if (run) {
        write('  aborting the run and stopping participants')
        await run.abort(rest || 'exited at the console')
      }
      leave()
      return
    }

    if (word?.startsWith('/')) return void write(`  unknown command: ${word} — /help`)

    // Plain text. Addressed, at human rank, and NOT delivered mid-turn: it is queued as
    // context the next exchange carries. Saying so beats letting the operator believe the
    // participant is reading over their shoulder.
    // `>both` is spelled out for discoverability and means exactly what plain text means.
    if (word === '>both') {
      if (!rest) return void write('  >both needs something to say')
      if (!run) {
        begin(rest)
        return
      }
      inject(rest, 'all')
      queued('everyone')
      return
    }

    if (word === '>advisor' || word === '>implementer') {
      const who = word.slice(1)
      if (!rest) return void write(`  ${word} needs something to say`)
      // With no run there is no loop to drain a queue, so this is a direct exchange rather
      // than a queued message. The participants are still alive — only the loop stopped —
      // and the things you want between runs are exactly the ones that are not a new goal:
      // start the server so I can try it, explain what you changed, tidy that up.
      if (!run) return void askDirectly(who, rest)
      inject(rest, { only: who })
      // Nothing written about the exclusion. The pinned row says `→ implementer` while the
      // message waits and the speaker block says it again when it lands, so a line stating
      // who did NOT get it is a third telling of the same fact — and the one that reads
      // like a warning. `/audit` still answers the question on demand.
      queued(who)
      return
    }
    // The first thing typed is the goal; everything after it is a constraint on the run in
    // progress. A session that demanded its objective up front assumed you arrive knowing
    // it, which is not how anyone gets to one.
    if (!run) {
      begin(message)
      return
    }
    // Answering a pause IS the decision, so it resumes. A reply typed at a pause used to sit
    // queued with the run still stopped, needing a separate `/continue` to count -- the same
    // failure as a menu option that no-ops: the operator acted, something was recorded, and
    // nothing moved.
    //
    // Only at a pause. Mid-run there is nothing to resume and the line is genuinely held for
    // the next turn boundary, which `queued()` says.
    //
    // Through `answerPause`, which `/continue <message>` also calls: same delivery, same
    // order, same resume, whichever spelling the operator reached for.
    if (run.state === 'paused') return void (await answerPause(message))
    inject(message, 'all')
    queued('everyone')
  }

  try {
    if (opts.goal) begin(opts.goal)
    else {
      // Named by the directory until a goal exists, because that is what distinguishes one
      // waiting session from another and the goal has not been typed yet.
      title('waiting')
      write(dim('  no goal given — type one to start, or /help'))
    }

    // At a terminal, the session outlives a run: participants stay alive between tasks so
    // the next instruction does not pay for a fresh pair of sessions, and the console
    // returns to the prompt.
    //
    // Piped, it does not. A script has no way to say "I am finished thinking" other than
    // closing its input, and a console that waits for that after the work is done is a
    // hang — which is exactly what it became, for every test, until this distinction.
    if (interactive) {
      await new Promise<void>((resolve) => {
        closed = resolve
      })
    } else {
      await Promise.race([
        firstRunEnded,
        new Promise<void>((resolve) => rl!.once('close', () => resolve())),
      ])
    }
  } finally {
    // Every exit path tears down. A console that leaks participants on an unexpected throw
    // is worse than no console, because the leak is invisible until the next run refuses
    // to start on a lock it does not recognise.
    // Set on EVERY exit path, not just `leave()`. The non-interactive form returns without
    // ever calling it, so `done` stayed false while readline was closed underneath the
    // callbacks that check it.
    done = true
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onInterrupt)
    // `leave()` releases it too, and this is the path a throw or a piped run takes — which
    // is exactly the case where a stale title would survive with nothing left to explain it.
    if (liveTerminal) target.write(releaseTitleSequence())
    screen?.close()
    rl?.close()
    recording.set('ended')
    // AFTER the relay: stopping it is what closes the event stream, and closing the
    // recorder first would cut the terminal `run_end` off before it was read.
    await relay.stop()
    await recording.close()
    tee?.end()
  }
  return 0
}
