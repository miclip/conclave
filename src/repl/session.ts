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

import { clearLine, createInterface, cursorTo, type Interface } from 'node:readline'
import { bold, colorFor, dim, grey, markdown, setColor, speakerColor, Status, yellow } from './render.ts'
import type { AgentEvent } from '../contract/session.ts'
import { defaultRegistry } from '../registry/builtin.ts'
import type { AgentRegistry } from '../registry/registry.ts'
import { Relay } from '../relay/relay.ts'
import type { RelayMessage } from '../relay/message.ts'
import type { RunHandle, RunPause } from '../relay/run.ts'
import { guard } from '../workspace/sessionLock.ts'

export interface SessionOptions {
  cwd: string
  goal: string
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
}

const HELP = `
  <text>                 send to everyone, at human rank
  @advisor <text>        send to the advisor only — the implementer will not see it
  @implementer <text>    send to the implementer only — the advisor will not see it

  /pause                 pause at the next round boundary
  /continue              resume from a pause
  /rotate [reason]       replace the implementer, carrying a handoff forward
  /abort [reason]        end the run

  /state                 run state, participants, pending pause
  /log [n]               last n routing entries (default 20)
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
  // `constrain` is not a command — you constrain by typing. Offering it as one sent people
  // looking for a slash command that does not exist.
  const commands = p.options.filter((o) => o !== 'constrain').map((o) => `/${o}`)
  lines.push('', `  ${dim(commands.join('   '))}   ${dim('or type a message')}`, '')
  return lines.join('\n')
}

export async function runSession(opts: SessionOptions): Promise<number> {
  const out = opts.output ?? process.stdout
  const width = Math.min(100, (out as NodeJS.WriteStream).columns ?? 100)
  setColor(colorFor(out as NodeJS.WriteStream))
  const interactive =
    (opts.input ?? process.stdin) === process.stdin && process.stdin.isTTY === true
  let rl: Interface | undefined
  let statusRef: Status | undefined

  /**
   * Write a line without eating what the operator is halfway through typing.
   *
   * Activity arrives asynchronously while readline is holding a partial line, so a bare
   * `out.write` interleaves with it and the typed text is visually destroyed. Clearing the
   * current line, writing, and re-prompting with `preserveCursor` redraws the prompt AND
   * the buffer, which is what makes this usable rather than merely functional.
   */
  const write = (s: string) => {
    statusRef?.clear()
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

  write(`starting ${opts.lead} (advisor) and ${opts.implementer} (implementer) in ${opts.cwd}`)
  if (opts.checks.length === 0) {
    write(`no rotation checks configured — a degraded implementer will escalate rather than rotate`)
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
  const status = new Status(out, interactive, () => (rl?.line?.length ?? 0) > 0)
  statusRef = status
  void (async () => {
    for await (const e of relay.observe({ replay: false })) {
      if (e.type !== 'activity') continue
      const ev = e.event
      if (ev.type === 'turn_start') {
        status.start(`${speakerColor(e.participant, e.rank)(e.participant)} working`)
      } else if (ev.type === 'turn_end') {
        status.clear()
      } else if (ev.type === 'tool_use') {
        status.detail(ev.tool)
      } else {
        const line = renderActivity(e.participant, ev)
        if (line) {
          status.clear()
          write(line)
        }
      }
    }
  })()

  const run: RunHandle = relay.start(opts.goal)
  let done = false
  /** Resolvers for the pause loop, released when the operator resumes or aborts. */
  const resumed: (() => void)[] = []
  const wake = () => {
    const r = resumed.shift()
    if (r) r()
  }

  // The pause loop. `settled()` covers both a pause and the end, which is what a supervising
  // caller wants and why holding `result()` here would be wrong.
  const supervising = (async () => {
    for (;;) {
      const s = await run.settled()
      if (s.kind === 'ended') {
        done = true
        write(`\n=== run ended: ${s.outcome.reason}${s.outcome.detail ? ` — ${s.outcome.detail}` : ''}`)
        write(`=== ${relay.log.length} messages routed`)
        return
      }
      write(renderPause(s.pause, width))
      // Nothing further happens until the operator says so. That is the point.
      await new Promise<void>((resolve) => resumed.push(resolve))
    }
  })()

  rl = createInterface({
    input: opts.input ?? process.stdin,
    output: out,
    prompt: '> ',
    // Keyed off whether it IS a terminal, not whether a stream was injected. The first
    // live run piped stdin and got `[1G[0J>` escape sequences in the log, because readline
    // was drawing a prompt for a pipe.
    terminal: interactive,
  })
  const prompt = () => {
    if (!done) rl!.prompt()
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
    void run.abort('interrupted at the console').then(wake, wake)
  }
  rl.on('SIGINT', onInterrupt)
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onInterrupt)

  rl.on('line', (raw) => {
    const line = raw.trim()
    void (async () => {
      try {
        if (line) await handle(line)
      } catch (err) {
        write(`  ! ${err instanceof Error ? err.message : String(err)}`)
      }
      prompt()
    })()
  })

  async function handle(line: string): Promise<void> {
    const [word, ...restWords] = line.split(/\s+/)
    const rest = restWords.join(' ')

    if (word === '/help') return void write(HELP)

    if (word === '/state') {
      write(`  run: ${run.state}${run.pause ? ` (${run.pause.reason})` : ''}`)
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
      if (run.state === 'paused') return void write('  already paused')
      write('  pausing at the next round boundary — a turn in flight has to finish first')
      void run.requestPause('the operator asked to pause')
      return
    }

    if (word === '/continue') {
      if (run.state !== 'paused') return void write(`  not paused (${run.state})`)
      await run.continue()
      wake()
      return
    }

    if (word === '/rotate') {
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
      await run.abort(rest || 'aborted by the operator')
      wake()
      return
    }

    if (word?.startsWith('/')) return void write(`  unknown command: ${word} — /help`)

    // Plain text. Addressed, at human rank, and NOT delivered mid-turn: it is queued as
    // context the next exchange carries. Saying so beats letting the operator believe the
    // participant is reading over their shoulder.
    if (word === '@advisor' || word === '@implementer') {
      const who = word.slice(1)
      if (!rest) return void write(`  ${word} needs something to say`)
      const m = run.injectConstraint(rest, { only: who })
      write(`  queued for ${who} at the next exchange — withheld from ${m.excluded.join(', ')}`)
      return
    }
    run.injectConstraint(line, 'all')
    write('  queued for everyone at the next exchange')
  }

  try {
    await supervising
  } finally {
    // Every exit path tears down. A console that leaks participants on an unexpected throw
    // is worse than no console, because the leak is invisible until the next run refuses
    // to start on a lock it does not recognise.
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onInterrupt)
    status.clear()
    rl.close()
    await relay.stop()
  }
  return 0
}
