/**
 * What the seats are told about the goal, and whether it is true.
 *
 * The briefings used to assert a secrecy boundary this tool cannot enforce. An implementer was
 * told "you have not been given it, and that is deliberate rather than an oversight — do not go
 * looking for it or ask what it is"; the advisor was told it HELD the goal and could withhold it
 * so that "a reviewer told what verdict is wanted stops being a reviewer".
 *
 * Every run writes the goal in full to `.conclave/sessions/<id>/status.json`, in the working
 * directory every seat shares, and that file is deliberately inspectable — `sessionRecord.ts`
 * argues for a file rather than a socket precisely so it outlives the process and can be read
 * with `cat` from anywhere. A seat with shell access to the repository therefore cannot be given
 * an enforceable secrecy boundary, and a briefing that claimed one was asking a participant to
 * believe something false while inviting the advisor to plan around it.
 *
 * So the claims are now about SCOPE AND SEQUENCING, and this file holds both halves together:
 * the wording each seat receives, and the fact that wording asserts, proved by reading the goal
 * back out of a real run's own record. Splitting them is how the text would drift back — the
 * warning is only honest for as long as the file it names still carries the goal.
 *
 *   node --test src/relay/goalDisclosure.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { main } from '../../bin/conclave.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { handoffPrompt } from '../rotation/handoff.ts'
import { tempDir } from '../testkit/tempDir.ts'

/**
 * Claims no briefing may make again, as the text that would carry them.
 *
 * Written as the SENTENCES rather than as a flag, because the failure being guarded is prose
 * drifting back — someone restoring "do not go looking for it" while every structural test
 * still passes. Each entry is a phrase from the wording that was actually shipped.
 */
const FALSE_CLAIMS: readonly { pattern: RegExp; was: string }[] = [
  { pattern: /have not been given\s+it/i, was: 'the implementer has not been given the goal' },
  { pattern: /do not go looking for it/i, was: 'the implementer must not look for the goal' },
  { pattern: /YOU HOLD THE GOAL/, was: 'the advisor holds — and so controls — the goal' },
  { pattern: /advisor holds this session's goal/i, was: 'the advisor holds the goal' },
  { pattern: /it does not hold this session's goal/i, was: 'a replacement cannot hold the goal' },
  { pattern: /what it knows is what you\s+write here/i, was: 'the handoff bounds what a replacement can know' },
  { pattern: /stops being a reviewer/i, was: 'withholding buys an unbiased review' },
  { pattern: /[Ww]ithholding is not licence/, was: 'framing disclosure as withholding' },
  // The two this table did not catch on its first pass, and they are the instructive ones:
  // both survived because they are about who has the goal rather than about what a seat may
  // do, so every "do not go looking" pattern above passed straight over them.
  //
  // "The human gave it to you and not to the implementer" is a claim about the OPERATOR's
  // choice, and it is not one this program is in a position to make. The human wrote a goal;
  // what conclave decides is which prompt it is pasted into. Told the human chose it over the
  // implementer, an advisor reasonably infers an intention behind the split -- which is the
  // same wrong inference the notice below it now spends a paragraph undoing.
  { pattern: /gave it to you and not to the implementer/i, was: 'the human chose the advisor over the implementer' },
  // "hold no goal" says a reviewer is CONSTITUTED without one. It shares a working directory
  // with the record that has it, so what is true is only that this message does not carry it.
  { pattern: /holds? no goal/i, was: 'the reviewer is a seat that cannot hold the goal' },
]

/**
 * One line, so a phrase that spans a wrap is still one phrase.
 *
 * The briefings are hard-wrapped prose. Asserting on the raw text pins where the wrap happens
 * to fall as tightly as it pins the words, so an edit that rewrapped a paragraph without
 * changing a syllable would fail -- and the natural repair for that failure is to loosen the
 * assertion until it stops saying anything.
 */
function flowed(text: string): string {
  return text.replace(/\s+/g, ' ')
}

function assertNoFalseClaims(text: string, where: string): void {
  for (const { pattern, was } of FALSE_CLAIMS) {
    assert.ok(
      !pattern.test(text),
      `${where} makes a claim this tool cannot keep (${was}); the text still matches ${pattern}`,
    )
  }
}

/** A scratch project. `relay` refuses to run outside a git repository. */
function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-goal-disclosure')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'work.ts'), 'export const a = 1\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

interface Ran {
  code: number
  dir: string
  /** What each seat was actually sent, in order, by seat id. */
  received: Map<string, string[]>
}

/**
 * One real `relay` run in a scratch project, with every seat's traffic captured.
 *
 * Driven through `main` rather than through `Relay.start`, because half of what is asserted
 * here is written by the CLI and not by the relay: the session record is opened by the front-end
 * (`recordSession`), and a test that built the relay directly would prove the briefings honest
 * against a file that this run never wrote.
 */
async function run(dir: string, goal: string, argv: readonly string[] = []): Promise<Ran> {
  const received = new Map<string, string[]>()
  const registry = new AgentRegistry()
  for (const agent of ['fake-lead', 'fake-impl']) {
    registry.register({
      id: agent,
      displayName: agent,
      capabilities: {
        agent,
        readinessSignal: 'unknown',
        turnKeySource: 'prompt_id',
        outcomes: {
          completed: 'observed',
          cancelled: 'reasoned_but_unverified',
          permission_refused: 'reasoned_but_unverified',
          process_exited: 'reasoned_but_unverified',
          timed_out: 'reasoned_but_unverified',
          transport_lost: 'reasoned_but_unverified',
          unknown_abnormal_end: 'reasoned_but_unverified',
        },
      },
      deadlines: NO_DEADLINE_CLOCKS,
      launch: { command: agent, baseArgs: [] },
      async create(resolved) {
        // One DONE from the advisor ends the run at its first turn, which is all this needs:
        // the openings are sent before any of it.
        const session = new FakeRotationSession(
          `${agent}-1`,
          agent,
          agent === 'fake-lead' ? ['DONE'] : [],
        )
        received.set(resolved.spec.id, session.received)
        return session
      },
    })
  }
  const beforeCwd = process.cwd()
  const [log, error] = [console.log, console.error]
  console.log = () => {}
  console.error = () => {}
  try {
    process.chdir(dir)
    const code = await main(['relay', goal, '--advisor', 'fake-lead', '--implementer', 'fake-impl', ...argv], {
      registry,
      input: (() => {
        const s = new PassThrough()
        s.end()
        return s
      })(),
      output: new Writable({ write: (_c, _e, cb) => void cb() }),
    })
    return { code, dir, received }
  } finally {
    process.chdir(beforeCwd)
    console.log = log
    console.error = error
  }
}

/** The goal as this run's own operator record carries it. */
function recordedGoal(dir: string): string {
  const sessions = join(dir, '.conclave', 'sessions')
  const ids = readdirSync(sessions)
  assert.equal(ids.length, 1, 'the run must have recorded exactly one session')
  const status = JSON.parse(readFileSync(join(sessions, ids[0]!, 'status.json'), 'utf8')) as {
    goal: string
  }
  return status.goal
}

/**
 * A goal with something in it a reader would notice, and more than one line of it.
 *
 * Multi-line on purpose: what the record has to carry is the COMPLETE goal, and a record that
 * kept a first line would satisfy a substring check while losing the acceptance criteria — the
 * half a seat reading it would most want.
 */
const GOAL =
  'Replace the rotation shim with the real transfer.\n' +
  '\n' +
  'Done means: `npm test` is green and the shim file is gone.'

test('the goal a run was given is in its own operator record, complete', async (t) => {
  // THE FACT THE BRIEFINGS NOW ASSERT. Not "a goal" but THE goal, whole, in the file the
  // wording names, in the working directory every seat shares. If this ever stops being true
  // the briefings below become false again, which is why it is asserted here rather than
  // assumed from `sessionRecord.ts`.
  const dir = repo(t)
  const ran = await run(dir, GOAL)
  assert.equal(ran.code, 0, 'the run must complete rather than refuse')
  assert.equal(recordedGoal(dir), GOAL, 'status.json carries the goal exactly as it was given')
})

test('the implementer is told where the goal went, and that reading the record is not a transgression', async (t) => {
  const dir = repo(t)
  const ran = await run(dir, GOAL)
  const opening = ran.received.get('implementer')?.[0] ?? ''
  assert.ok(opening.length > 0, 'the implementer must have been briefed')
  const said = flowed(opening)

  // Still not SENT the goal: routing is unchanged, and that is the only claim available.
  assert.ok(!opening.includes(GOAL), 'the goal is not delivered to the implementer')
  assert.match(said, /advisor is given this session's goal/i, 'it is told where the goal went')
  assert.match(said, /not sent to you with this briefing/i, 'and that it was not sent one')

  // THE HONEST WARNING, and each half of it. The file is NAMED, because "somewhere in the
  // repository" is not something a reader can check; the shared directory is named, because
  // that is why it is reachable; and the permission is stated, because an implementer told
  // only that the goal exists nearby would reasonably treat reading it as going behind the
  // advisor's back.
  assert.match(said, /scope and sequencing, not secrecy/i, 'the framing is stated outright')
  assert.match(said, /status\.json/, 'the file that holds it is named')
  assert.match(said, /working directory you share/i, 'and why it is reachable from here')
  assert.match(said, /nothing prevents you/i, 'and that nothing stops it being read')
  assert.match(
    said,
    /reading the record is not going behind anyone's back/i,
    'and that encountering it is not a transgression',
  )
  assertNoFalseClaims(said, "the implementer's briefing")
})

test('the advisor is told it steers rather than controls access', async (t) => {
  const dir = repo(t)
  const ran = await run(dir, GOAL)
  const opening = ran.received.get('advisor')?.[0] ?? ''
  assert.ok(opening.includes(GOAL), 'the advisor is given the goal in full')
  const said = flowed(opening)

  assert.match(said, /YOU ARE GIVEN THE GOAL AND YOU STEER/, 'steering is the responsibility named')
  assert.match(said, /SCOPE AND SEQUENCING/, 'and disclosure is framed as that')
  // Routing, stated as routing: what is in which prompt, which is the whole of what this
  // program decides about the goal. Not what the human chose, and not who is entitled to it.
  assert.match(
    said,
    /full goal is included in your briefing and is not repeated in the implementer's/i,
    'the split is described as prompt routing and nothing more',
  )
  // The two things it must not build a plan on, said as consequences rather than as theory:
  // an advisor that believed either would arrange a run around a boundary that is not there.
  assert.match(said, /do not control access to the goal/i, 'it does not control access')
  assert.match(said, /status\.json/, 'and the record that makes that so is named')
  assert.match(
    said,
    /not a guarantee that the implementer does not know/i,
    'withholding guarantees nothing about what the implementer knows',
  )
  assert.match(said, /not an independent review/i, 'and buys no unbiased review either')
  assertNoFalseClaims(said, "the advisor's briefing")
})

test('the reviewer gets the same honest notice, and its independence is not claimed from it', async (t) => {
  const dir = repo(t)
  const ran = await run(dir, GOAL, ['--reviewer', 'fake-impl'])
  const opening = ran.received.get('reviewer')?.[0] ?? ''
  assert.ok(opening.length > 0, 'the reviewer must have been briefed')
  const said = flowed(opening)

  assert.match(opening, /^You are the REVIEWER/, 'it is briefed as a reviewer')
  assert.ok(!opening.includes(GOAL), 'and is not sent the goal')
  // A fact about THIS MESSAGE, which is the only form of it that is true. What stood here was
  // "you do not write code and hold no goal" -- a claim about what the seat is, made to a seat
  // sharing a directory with the record that holds the goal.
  assert.match(said, /the goal is not sent in this briefing/i, 'said as a fact about the briefing')
  assert.match(said, /advisor is given this session's goal/i, 'it is told where the goal went')
  assert.match(said, /scope and sequencing, not secrecy/i, 'with the same honest framing')
  // What its independence DOES rest on, which is a property of the evidence rather than of
  // what it has read: a diff and a tree captured mechanically, never the producing seat's
  // account of its own work.
  assert.match(said, /never written or summarised by that seat/, 'independence is claimed from provenance')
  assertNoFalseClaims(said, "the reviewer's briefing")
})

test('the rotation handoff asks for scope, not for what a replacement is permitted to know', () => {
  // Rotation is where this went wrong most quietly: the handoff is the one place a goal used
  // to reach an implementer verbatim, so the prompt grew wording about what the replacement
  // "knows" -- a claim about access, in the document that is furthest from anyone checking it.
  const prompt = flowed(handoffPrompt('the implementer stopped reproducing the checks'))

  assert.match(prompt, /it is not sent this session's goal/i, 'routing is stated')
  assert.match(prompt, /what it is TOLD, it is told here/, 'and bounded to what it is told')
  assert.match(prompt, /a question of scope, not of secrecy/i, 'the BRIEF section says which question it is')
  assert.match(
    prompt,
    /the session record every seat can read/i,
    'and names why access is not the advisor’s to grant',
  )
  assertNoFalseClaims(prompt, 'the rotation handoff prompt')
})
