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

import { createWriteStream, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { clearLine, createInterface, cursorTo, type Interface } from 'node:readline'
import { suggest } from './complete.ts'
import { Screen } from './screen.ts'
import { banner, bold, colorFor, dim, elapsedSince, grey, markdown, Progress, rule, setColor, speakerColor, yellow } from './render.ts'
import type { AgentEvent } from '../contract/session.ts'
import { defaultRegistry } from '../registry/builtin.ts'
import type { AgentRegistry } from '../registry/registry.ts'
import { Relay } from '../relay/relay.ts'
import type { RelayMessage } from '../relay/message.ts'
import type { RunHandle, RunPause } from '../relay/run.ts'
import { trustCodexHooks } from '../deployment/codexHookTrust.ts'
import { installConfig } from '../config/install.ts'
import { guard } from '../workspace/sessionLock.ts'

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
  rounds: number
  /** Verification commands. Without them rotation is refused rather than done unverified. */
  checks: string[]
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
  '/state',
  '/log',
  '/queue',
  '/audit',
  '/help',
]

const HELP = `
  <text>                 send to everyone, at human rank
  <text>                 to BOTH, at human rank — the default, no prefix needed
  >advisor <text>        to the advisor only — the implementer will not see it
  >implementer <text>    to the implementer only — the advisor will not see it
  >both <text>           the same as no prefix; spelled out so the menu can offer it
  @src/relay/relay.ts    a path, anywhere in the line. Tab completes both sigils.

  They compose:  >advisor read @src/relay/relay.ts and tell me what it settles

  Paths are references, not inlined. Both participants share this directory and
  open the file themselves, and @path means the same to their own CLIs — so the
  reference survives being forwarded, which inlined text would not.

  /pause                 pause at the next round boundary
  /continue              resume from a pause
  /rotate [reason]       replace the implementer, carrying a handoff forward
  /abort [reason]        end the run

  /state                 run state, participants, pending pause
  /log [n]               last n routing entries (default 20)
  /queue                 what you have typed that has not been delivered yet
  /audit                 restricted messages: who was informed, who was excluded
  /help                  this
`

/** One line per event. Verbose enough to see progress, quiet enough to read the prose. */
function renderActivity(participant: string, e: AgentEvent): string | undefined {
  switch (e.type) {
    case 'tool_use':
      return `    · ${participant} ${e.tool}`
    case 'permission_requested':
      return `    ! ${participant} awaiting a permission decision`
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
  if (m.visibility === 'internal') return grey(`  ${m.text}`)
  const colour = speakerColor(m.from, m.fromRank)
  // The name alone when it already carries the rank; both only when they differ.
  const who = m.from === m.fromRank ? (m.fromRank === 'human' ? 'you' : m.from) : m.from
  const to = m.to.length ? dim(` → ${m.to.join(', ')}`) : dim(' → (recorded only)')
  const restricted =
    m.visibility === 'restricted' ? dim(`  ·  withheld from ${m.excluded.join(', ')}`) : ''
  return `\n${colour('●')} ${bold(who)}${to}${restricted}\n${markdown(m.text, { width })}`
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
  const interactive =
    (opts.input ?? process.stdin) === process.stdin && process.stdin.isTTY === true
  let rl: Interface | undefined
  let screen: Screen | undefined
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
   * Register the hooks for this checkout, if they are not already.
   *
   * Codex loads hooks from a sidecar in the working directory and Claude from project-local
   * settings, so a fresh checkout has neither and a session there would have no
   * turn-completion signal at all. Refusing with "run config install" was friction for a
   * fix the tool already knows how to perform.
   *
   * Both files are checkout-specific — they contain absolute paths — which is why they are
   * gitignored and never shipped, and why every new clone needs this once. Rendering is
   * idempotent, so this is a no-op on every run after the first and stays silent then.
   *
   * TRUST IS NOT TOUCHED. Codex will not run hooks in a directory it does not trust, and
   * that lives in the user's global `~/.codex/config.toml`. Writing project-local files
   * into a checkout the operator just asked to run a session in is theirs to expect;
   * silently editing their global configuration is not. It is reported instead.
   */
  // Only when the working directory IS the Conclave checkout.
  //
  // `installConfig` reads its templates relative to the root it is given, so pointing it at
  // an arbitrary working directory fails outright — the templates live with Conclave and
  // only the rendered output belongs in the target. Registering hooks into someone else's
  // repository from an installed release is a real gap, and a larger change than this:
  // `conclave config install` has the same shape and the same limit.
  // From the MODULE's location, not `resolveRepoRoot()` — that resolves from cwd, so it
  // reported every working directory as the Conclave checkout and sent installConfig
  // looking for templates that were never there.
  const ownCheckout = join(import.meta.dirname, '..', '..')
  const selfHosted =
    existsSync(opts.cwd) && realpathSync(opts.cwd) === realpathSync(ownCheckout)
  const installed = selfHosted
    ? await installConfig({ diagnose: false })
    : { written: [] as { label: string; path: string; changed: boolean }[] }
  const changed = installed.written.filter((w) => w.changed)
  if (changed.length > 0) {
    write(dim(`  registered hooks for this checkout: ${changed.map((w) => w.label).join(', ')}`))
    // Diagnose only on the run that actually wrote something: it spawns `codex app-server`
    // and costs a second or two, and it is only informative the first time. Registration
    // alone is not enough — Codex will not load hooks from a directory it does not trust,
    // and the preflight's own message ("check the sidecar file format") is misleading once
    // the sidecar is demonstrably correct.
    const diagnosed = await installConfig({ dryRun: true, diagnose: true })
    for (const m of diagnosed.codex?.messages ?? []) write(dim(`  ${m}`))
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
      const t = await trustCodexHooks(opts.cwd)
      const did = [t.askedAboutDirectory ? 'directory' : '', t.prompted ? 'hooks' : '']
        .filter(Boolean)
        .join(' and ')
      write(
        dim(
          did
            ? `  trusted: ${did}`
            : '  Codex showed no prompt; if turns end on the watchdog, run `codex` here once',
        ),
      )
    }
  }

  const relay = await Relay.start({
    registry: opts.registry ?? defaultRegistry(),
    cwd: opts.cwd,
    lead: { id: 'advisor', agent: opts.lead, role: 'advisor' },
    implementer: { id: 'implementer', agent: opts.implementer, role: 'implementer' },
    maxRounds: opts.rounds,
    ...(opts.checks.length > 0 ? { rotation: { checks: opts.checks } } : {}),
    onLog: (m) => write(renderMessage(m, width)),
  })

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
        progress.note(e.participant, ev.tool)
        if (screen) screen.draw()
        else progress.activity(e.participant, colour, ev.tool)
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
        // The session does not end with the run. There are participants alive and a human
        // at the prompt; ending here would throw away a working session at the exact moment
        // the next instruction was about to arrive.
        run = undefined
        runEnded?.()
        refreshPrompt()
        prompt()
        return
      }
      write(renderPause(s.pause, width))
      await new Promise<void>((resolve) => resumed.push(resolve))
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
  function promptText(): string {
    // Distinct messages, not deliveries. One line addressed to everyone is one thing the
    // operator typed; counting recipients reported "(2 queued)" for a single "continue".
    // Always the chevron. A `goal ›` prefix when idle made the prompt shift under the
    // cursor as a run started and ended, and the hint belongs in the footer, which is
    // where everything else that is not typed lives.
    const queued = new Set(relay.pending().flatMap((p) => p.texts)).size
    return queued > 0 ? `${dim(`(${queued} queued)`)} ${bold('›')} ` : `${bold('›')} `
  }

  const refreshPrompt = () => {
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
    const active = progress.line((p) => speakerColor(p, 'implementer')(p))
    const queued = new Set(relay.pending().flatMap((p) => p.texts)).size
    const idle = !run && !active ? dim('type a goal to start') : ''
    return [active, idle, queued > 0 ? dim(`${queued} queued`) : ''].filter(Boolean).join(dim('  ·  '))
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
      onInterrupt: () => onInterrupt(),
    })
    screen.open()
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
    const leave = () => {
      done = true
      screen?.close()
      rl?.close()
      closed?.()
    }
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
      if (!run) {
        done = true
        rl?.close()
        return
      }
      await run.abort(rest || 'aborted by the operator')
      wake()
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
      run.injectConstraint(rest, 'all')
      write('  queued for everyone at the next exchange')
      return
    }

    if (word === '>advisor' || word === '>implementer') {
      const who = word.slice(1)
      if (!rest) return void write(`  ${word} needs something to say`)
      if (!run) return void write(dim('  nothing is running; type a goal to start'))
      const m = run.injectConstraint(rest, { only: who })
      write(`  queued for ${who} at the next exchange — withheld from ${m.excluded.join(', ')}`)
      return
    }
    // The first thing typed is the goal; everything after it is a constraint on the run in
    // progress. A session that demanded its objective up front assumed you arrive knowing
    // it, which is not how anyone gets to one.
    if (!run) {
      begin(line)
      return
    }
    run.injectConstraint(line, 'all')
    write('  queued for everyone at the next exchange')
  }

  try {
    if (opts.goal) begin(opts.goal)
    else write(dim('  no goal given — type one to start, or /help'))

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
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onInterrupt)
    screen?.close()
    rl?.close()
    await relay.stop()
    tee?.end()
  }
  return 0
}
