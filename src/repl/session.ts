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
import { createWriteStream, existsSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Writable } from 'node:stream'
import { clearLine, createInterface, cursorTo, type Interface } from 'node:readline'
import { suggest } from './complete.ts'
import { Screen } from './screen.ts'
import { banner, bold, colorFor, dim, elapsedSince, grey, markdown, Progress, releaseTitleSequence, rule, setColor, speakerColor, titleSequence, yellow } from './render.ts'
import type { AgentEvent } from '../contract/session.ts'
import { defaultRegistry } from '../registry/builtin.ts'
import type { CheckSpec } from '../rotation/record.ts'
import type { AgentRegistry } from '../registry/registry.ts'
import { Relay } from '../relay/relay.ts'
import type { RelayMessage } from '../relay/message.ts'
import type { RunHandle, RunPause } from '../relay/run.ts'
import {
  CONCLAVE_HOOK_MATCH,
  trustCodexHooks,
  waitForCodexHooksExecutable,
} from '../deployment/codexHookTrust.ts'
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
import { guard } from '../workspace/sessionLock.ts'
import { newSessionId, projectRootFor, recordSession } from '../workspace/sessionRecord.ts'

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
   * Extra launch arguments per seat, e.g. `['-m', 'opencode/kimi-k2.6']`.
   *
   * Required rather than cosmetic for any agent that selects its model per invocation: an
   * `opencode` participant with no model pinned does not fail, it HANGS -- see issue #23.
   * Wiring this into `relay` and not here is the mistake this codebase has made four times.
   */
  leadArgs?: string[] | undefined
  implementerArgs?: string[] | undefined
  rounds: number
  /**
   * Verification commands. A bare string is `required`; pass `{command, relevance}` for a
   * check that should run and be reported without gating a transfer.
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
  /** Streams for testing; defaults to the process's own. */
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  /** Injected for testing. Production uses the built-in registry. */
  registry?: AgentRegistry
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
const COMMANDS = [
  '/pause',
  '/continue',
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

const HELP = `
  <text>                 to BOTH, at human rank — the default, no prefix needed
  >advisor <text>        to the advisor only — the implementer will not see it
  >implementer <text>    to the implementer only — the advisor will not see it
  >both <text>           the same as no prefix; spelled out so the menu can offer it
  @src/relay/relay.ts    a path, anywhere in the line. Tab completes both sigils.

  They compose:  >advisor read @src/relay/relay.ts and tell me what it settles

  With a run going, an addressed line is QUEUED and delivered at the next turn
  boundary. With no run, it is asked directly and you wait for the answer — the
  participants are still alive between runs, which is where the loose ends live:
  start the server so I can try it, explain that change, tidy this up.

  Paths are references, not inlined. Both participants share this directory and
  open the file themselves, and @path means the same to their own CLIs — so the
  reference survives being forwarded, which inlined text would not.

  /pause                 pause at the next round boundary
  /continue              resume from a pause
  /rotate [reason]       replace the implementer, carrying a handoff forward
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
  lines.push('', `  ${dim(commands.join('   '))}   ${dim('or type a message')}`, '')
  return lines.join('\n')
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
  const existing = guard(opts.cwd)
  if (existing.live) {
    write(`refusing to start: ${existing.messages.join('\n')}`)
    return 1
  }

  write(
    banner({
      version: opts.version ?? '0.0.0',
      advisor: opts.lead,
      implementer: opts.implementer,
      cwd: opts.cwd,
      checks: opts.checks,
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
  const agents = [...new Set([opts.lead, opts.implementer])].filter(isAgentKind)
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
    const diagnosed = await installConfig({
      projectRoot: opts.cwd,
      agents,
      dryRun: true,
      diagnose: true,
    })
    // The diagnosis messages are written for `config check`, where the operator is the one
    // who has to act: five near-identical paragraphs, each naming a `hooks.state` key to
    // paste into a TOML file. Here the tool is about to do that itself, so printing them
    // is telling someone how to perform a job already in hand. They are held back and
    // shown only if the fix does not work — the one case where the operator needs them.
    if (diagnosed.codex && !diagnosed.codex.ready) {
      // Registration is not enough: Codex never executes hooks in a directory it does not
      // trust, and does so silently — turns end on watchdog inference, every verdict is
      // `uncertain`, and nothing says why.
      //
      // This writes to the operator's GLOBAL config, which is heavier than anything else
      // here, so it is append-only, idempotent, and announced with the exact lines added.
      // Both halves of Codex's trust — the directory and the hooks — are answered by the
      // prompts Codex itself shows. An earlier version hand-appended a
      // `[projects."<cwd>"] trust_level` stanza to the operator's global config; that
      // duplicated what this already does, and did it by editing their file directly
      // instead of going through the flow Codex supports.
      write(dim('  trusting this directory and its hooks with Codex — answers its own prompts once'))
      // This waits on a REAL Codex TUI to draw its prompts: up to 8s for the directory
      // question, up to 45s for the hook review, plus settle time. Silence for that long
      // reads as a hang, and the operator has no way to know it is not one — so it uses
      // the same `⋯ name elapsed · detail` vocabulary a working participant does.
      //
      const t = await withHeartbeat(
        out,
        'configuring',
        'waiting for Codex to show its trust prompts',
        () => trustCodexHooks(opts.cwd),
        { inPlace: liveTerminal },
      )
      // Codex records the decision when it EXITS, so confirm rather than assume. Without
      // this the preflight a moment later reads the pre-trust state and refuses, which
      // presents as the session being flaky rather than as Codex having been slow.
      const ready = await withHeartbeat(
        out,
        'configuring',
        'confirming Codex recorded the decision',
        () => waitForCodexHooksExecutable(opts.cwd, CONCLAVE_HOOK_MATCH),
        { inPlace: liveTerminal },
      )
      const did = [t.askedAboutDirectory ? 'directory' : '', t.prompted ? 'hooks' : '']
        .filter(Boolean)
        .join(' and ')
      if (ready) {
        write(dim(`  configured: trusted ${did || 'nothing left to trust'}`))
      } else {
        // Now the operator does have to act, so give them everything: what Codex reports
        // for each handler, and the exact key to pre-seed.
        write(dim('  Codex still will not run these hooks. Turn outcomes will be inferred:'))
        const detail = await installConfig({ projectRoot: opts.cwd, agents, dryRun: true, diagnose: true })
        for (const m of detail.codex?.messages ?? []) write(dim(`  ${m}`))
      }
    }
  }

  // Read before anything is launched, and loudly: a malformed config that silently meant
  // "ask" would present as a session that stops on every command for no stated reason.
  const projectConfig = readProjectConfig(opts.cwd)
  // Config-derived first, then per-invocation, so an explicit flag wins.
  const leadArgs = [...launchArgsFor(projectConfig, opts.lead), ...(opts.leadArgs ?? [])]
  const implArgs = [
    ...launchArgsFor(projectConfig, opts.implementer),
    ...(opts.implementerArgs ?? []),
  ]

  // Said once, at the top, naming who. A session that never asks permission is a thing
  // the operator should be reminded of while it runs, not something they configured weeks
  // ago in a file they are not looking at.
  const bypassing = [
    permissionModeFor(projectConfig, opts.lead) === 'bypass' ? `advisor (${opts.lead})` : '',
    permissionModeFor(projectConfig, opts.implementer) === 'bypass' ? `implementer (${opts.implementer})` : '',
  ].filter(Boolean)
  if (bypassing.length > 0) {
    write(yellow(`  permission prompts bypassed for ${bypassing.join(' and ')} — per ${CONFIG_RELATIVE}`))
  }

  const relay = await Relay.start({
    registry: opts.registry ?? defaultRegistry(),
    cwd: opts.cwd,
    ...(opts.operator ? { operator: opts.operator } : {}),
    lead: { id: 'advisor', agent: opts.lead, role: 'advisor', ...(leadArgs.length > 0 ? { args: leadArgs } : {}) },
    implementer: {
      id: 'implementer',
      agent: opts.implementer,
      role: 'implementer',
      ...(implArgs.length > 0 ? { args: implArgs } : {}),
    },
    maxRounds: opts.rounds,
    ...(opts.checks.length > 0 ? { rotation: { checks: opts.checks } } : {}),
    onLog: (m) => {
      // A message the operator just typed is already on screen twice over: the pinned row
      // shows the text itself while it waits, and `pendingRows` promotes it to a speaker
      // block the moment a participant takes it. Rendering it here as well put the
      // delivered block above and the queued row below — the same sentence, twice, with
      // nothing to say which was which.
      //
      // Piped input has no box, so there this is the only copy and it must still print.
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
        write(`\n=== run ended: ${s.outcome.reason}${s.outcome.detail ? ` — ${s.outcome.detail}` : ''}`)
        write(`=== ${relay.log.length} messages routed`)
        // The rotation summary and any carried flags, on BOTH front-ends. The console had
        // neither: a `done` carrying an unresolved caveat read as unqualified success here
        // too, and an operator who was present for the turn is not thereby guaranteed to
        // have registered a single sentence 300 lines ago.
        write(`=== ${relay.rotationSummary()}`)
        for (const line of relay.flagSummary()) write(`=== ${line}`)
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
    const active = progress.line((p) => speakerColor(p, p === 'advisor' ? 'advisor' : 'implementer')(p))
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
    // Only the resting reminder. Whenever there is something to choose the screen draws the
    // menu here instead, because a suggestion belongs against the keystroke that produced
    // it and anywhere in the transcript it would scroll away from it.
    const line = screen?.line ?? ''
    return line ? '' : `  ${dim('/ for commands  ·  > to address  ·  @ for a path  ·  no prefix goes to both')}`
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
      onInterrupt: () => onInterrupt(),
    })
    screen.open()
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

  function submit(raw: string): void {
    const line = raw.trim()
    void (async () => {
      try {
        if (line) await handle(line)
      } catch (err) {
        write(`  ! ${err instanceof Error ? err.message : String(err)}`)
      }
      refreshPrompt()
      prompt()
    })()
  }
  rl?.on('line', submit)

  async function handle(line: string): Promise<void> {
    const [word, ...restWords] = line.split(/\s+/)
    const rest = restWords.join(' ')

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
      write('  pausing at the next round boundary — a turn in flight has to finish first')
      void run.requestPause('the operator asked to pause')
      return
    }

    if (word === '/continue') {
      if (!run) return void write(dim('  nothing is running; type a goal to start'))
      if (run.state !== 'paused') return void write(`  not paused (${run.state})`)
      await run.continue()
      wake()
      return
    }

    if (word === '/rotate') {
      if (!run) return void write(dim('  nothing is running; type a goal to start'))
      if (run.state !== 'paused') return void write('  pause first: /pause, then /rotate')
      write('  rotating — the advisor writes a handoff, then a replacement must reproduce the record')
      const result = await run.rotateImplementer(rest || undefined)
      if (result.status === 'rotated') {
        write(`  rotated into ${result.replacement.sessionId}; still paused — /continue when ready`)
        for (const c of result.acceptance.carriedFailures) {
          write(`  carried forward failing: \`${c.command}\` exits ${c.exitCode}, as it did at handoff`)
        }
      } else {
        write(`  rolled back (${result.reason}): ${result.detail}`)
        write(`  the original is back in service; still paused — /continue when ready`)
      }
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
      begin(line)
      return
    }
    inject(line, 'all')
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
