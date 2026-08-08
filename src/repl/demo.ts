/**
 * The console, driven by scripted participants.
 *
 * Every console change so far has been checked by running a real two-agent session: two
 * CLIs, real quota, minutes per look. Three rendering faults survived that loop because the
 * offline tests pass against a pipe and the faults only exist against a terminal — and the
 * loop was too slow to iterate through.
 *
 * This runs the real console, in a real terminal, with real readline and real dimensions,
 * against fakes that narrate and use tools on a timer. It costs nothing and takes seconds,
 * so a rendering change can be looked at before it is inflicted on a session.
 *
 * It is NOT a substitute for a live run. The fakes cannot reproduce a transcript flush
 * race, an adapter disagreement, or anything about how the models actually behave. It
 * checks that the console draws correctly, and nothing else.
 *
 *   conclave demo
 *   conclave demo --record /tmp/out.txt
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { runSession } from './session.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'

const CAPS = {
  readinessSignal: 'unknown' as const,
  turnKeySource: 'prompt_id' as const,
  outcomes: {
    completed: 'observed' as const,
    cancelled: 'reasoned_but_unverified' as const,
    permission_refused: 'reasoned_but_unverified' as const,
    process_exited: 'reasoned_but_unverified' as const,
    timed_out: 'reasoned_but_unverified' as const,
    transport_lost: 'reasoned_but_unverified' as const,
    unknown_abnormal_end: 'reasoned_but_unverified' as const,
  },
}

/** Prose with the shapes participants actually produce: headings, tables, code, lists. */
const REPORT = `## What I found

\`src/relay/relay.ts:214\` reads the snapshot the instant \`turn_end\` arrives. Two record
types carry arguments in **different fields**:

| record type | arg field | count |
|---|---|---|
| \`custom_tool_call\` | \`input\` | 2839 |
| \`function_call\` | \`arguments\` | 1454 |

- \`apply_patch\` — structured, repo-relative, reliably extractable
- \`exec\` — a *JavaScript program string*, not JSON

> Treat the counts as approximate; the direction is not in doubt.

\`\`\`ts
const r = await tools.exec_command({ cmd: 'pwd && rg --files' })
\`\`\`

**Nothing edited.** Say go and I will.`

function scripted(id: string, agent: string, replies: string[], narration: string[]): FakeRotationSession {
  const s = new FakeRotationSession(id, agent, replies)
  s.delayMs = 3_000
  if (narration.length > 0) s.narrate(narration, replies.at(-1) ?? '')
  return s
}

export async function runDemo(opts: { record?: string | undefined }): Promise<number> {
  const work = mkdtempSync(join(tmpdir(), 'conclave-demo-'))
  execFileSync('git', ['init', '-q'], { cwd: work })
  writeFileSync(join(work, '.gitignore'), '.conclave/\n')
  // A tree with something in it, so `@` completion has something to complete. A demo whose
  // directory is empty demonstrates the console against conditions nobody works in.
  mkdirSync(join(work, 'src', 'relay'), { recursive: true })
  for (const f of ['relay.ts', 'run.ts', 'observe.ts']) writeFileSync(join(work, 'src', 'relay', f), '')
  mkdirSync(join(work, 'src', 'rotation'), { recursive: true })
  writeFileSync(join(work, 'src', 'rotation', 'rotate.ts'), '')
  writeFileSync(join(work, 'README.md'), '')
  execFileSync('git', ['add', '.'], { cwd: work })
  execFileSync('git', ['-c', 'user.email=d@d', '-c', 'user.name=d', 'commit', '-qm', 'init'], { cwd: work })

  const advisor = scripted(
    'advisor',
    'codex',
    ['Trace how the relay reads a report, and tell me what you find before editing.', 'DONE'],
    [],
  )
  const implementer = new FakeRotationSession('implementer', 'claude', ['Acknowledged.', REPORT])
  implementer.delayMs = 7_000
  implementer.narrate(
    [
      "I'll start by orienting in the repo.",
      'Now the exchange path, since that is where the snapshot is read.',
      'Checking whether the adapters agree on what assistantText means.',
    ],
    REPORT,
  )

  const registry = new AgentRegistry()
  for (const [agent, session] of [
    ['codex', advisor],
    ['claude', implementer],
  ] as [string, AgentSession][]) {
    registry.register({
      id: agent,
      displayName: agent,
      capabilities: { ...CAPS, agent },
      // An in-memory double: no child process, so no clock of either kind.
      deadlines: NO_DEADLINE_CLOCKS,
      launch: { command: agent, baseArgs: [] },
      async create() {
        return session
      },
    })
  }

  // Tool use on a timer, so the progress lines have something to report.
  const tools = ['Read', 'Grep', 'Bash', 'Edit', 'Bash']
  let n = 0
  const ticker = setInterval(() => {
    implementer.emit({
      type: 'tool_use',
      tool: tools[n++ % tools.length]!,
      input: {},
      seq: 9000 + n,
      at: Date.now(),
      provisional: true,
    })
  }, 700)
  ticker.unref()

  const code = await runSession({
    cwd: work,
    goal: 'Trace how a report is read from the transcript and report before editing.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 4,
    checks: ['npm test'],
    version: 'demo',
    registry,
    progressEveryMs: 2_500,
    ...(opts.record ? { record: opts.record } : {}),
  })
  clearInterval(ticker)
  return code
}
