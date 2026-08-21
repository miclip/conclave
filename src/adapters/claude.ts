/**
 * ClaudePtyHookAdapter — the first live adapter.
 *
 * Deliberately mechanical. It owns process lifecycle, sanitized environment, input
 * serialization, hook ingestion, transcript reconciliation and evidence classification.
 * It owns no relay policy, no advisor-turn budgets, no role prompting and no summarisation --
 * those belong above the seam and would make the adapter's guarantees harder to check.
 *
 * The three claims that were hardest to establish, and how they are honoured here:
 *
 *   completion   `Stop` proves it. Nothing else does.
 *   cancellation nothing in the child records it, so it rests entirely on the input
 *                queue's record of having sent ESC -- hence confidence `assumed`, and
 *                hence input mediation being a product-level guarantee rather than a
 *                convenience.
 *   loss         a lost `Stop` must not become `process_exited` on shutdown. Before
 *                finalising anything, the transcript is reconciled: an assistant entry
 *                with stop_reason=end_turn is correlation evidence that the turn
 *                completed even though its hook never arrived.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentSession,
  Guarantees,
  InputOwnership,
  Role,
  SendProvenance,
  SessionSnapshot,
  SessionState,
  TurnKey,
  TurnRecord,
} from '../contract/session.ts'
import { guaranteesFor, turnKey } from '../contract/session.ts'
import { emptyTranscriptState } from '../outcomes/classify.ts'
import { TurnVerdictTracker, type VerdictUpdate } from '../outcomes/tracker.ts'
import type { Verdict } from '../contract/outcome.ts'

import { DEFAULT_WATCHDOG_MS, TAIL_INTERVAL_MS, TurnWatchdog } from '../outcomes/watchdog.ts'
// The same function the run record reads, rather than a second parse of the same argv: what the
// diagnosis names must be what the report says this seat was launched with.
import { modelFromArgs } from '../registry/launch.ts'
import { sanitizedCopy } from '../process/childenv.ts'
import { PtyProcess } from '../process/pty.ts'
import { InputQueue } from '../process/input.ts'
import { HookReceiver } from '../hooks/receiver.ts'
import type { HookDelivery } from '../hooks/journal.ts'
import { TranscriptSessionView } from '../transcript/reconcile.ts'
import { AsyncQueue } from './asyncQueue.ts'

const CLIENT = join(import.meta.dirname, '..', 'hooks', 'client.ts')
/**
 * `SubagentStop` is registered and `SubagentStart` is not, because Claude Code has no such
 * event -- verified against the 2.1.224 bundle. So a delegating turn can be seen to have
 * FINISHED delegating and never to have started, which is why the console falls back to
 * naming the tool call. Kimi has both; see `kimiConfig.ts`.
 */
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'SubagentStop',
  'Stop',
  'SessionEnd',
]

/**
 * Event types that mean the CHILD produced something.
 *
 * The complement is the interesting half: `turn_start` is emitted by this adapter the moment it
 * arms a clock, and `revision`/`error` are this adapter reporting on itself, so none of them
 * distinguishes a child that is working from one that has never said a word.
 */
const CHILD_OUTPUT = new Set<AgentEvent['type']>(['message', 'tool_use', 'permission_requested'])

interface TurnState {
  key: TurnKey
  prompt: string
  startedAt: number
  /**
   * Owns this turn's evidence and verdict. Replaces the previous one-shot finalisation,
   * which could
   * not represent Codex-style classification at all: the outcome depends on evidence
   * arriving through four different channels -- transcript records, the hook stream, the
   * mediated input log, and the input-ownership policy -- and some of it arrives after a
   * verdict has already been reported.
   */
  tracker: TurnVerdictTracker
  /** Seq of the last `turn_end` emitted, so a revision can withdraw it by number. */
  endSeq: number | undefined
  assistantText: string | undefined
  /**
   * Whether the CHILD has said anything during this turn (#82).
   *
   * Not `lastActivityAt`, which cannot answer this: the adapter emits `turn_start` the instant
   * it arms, so every turn looks active from its first millisecond. This is set only by output
   * that came from the child, which is what separates "went quiet" from "never spoke".
   */
  produced: boolean
}

/**
 * What the adapter knows about a turn, independently of the transcript.
 *
 * Named so the merge below can be tested without booting a pty. The merge is where a
 * hook-derived fallback was being silently discarded, and a defect in a private method of a
 * class that only constructs by spawning a real CLI is a defect with nowhere to put a test.
 */
export interface KnownTurn {
  key: TurnKey
  prompt: string
  /** From `Stop`'s `last_assistant_message`. The fallback when the transcript has nothing. */
  assistantText: string | undefined
  verdict: Verdict | undefined
}

/**
 * Fold what the adapter knows into what the transcript says.
 *
 * Claude Code writes no per-turn id into its transcript, so correspondence is positional.
 * Hook-derived verdicts outrank transcript inference -- `Stop` PROVES completion, the
 * transcript only suggests it -- and a turn the adapter knows about beyond what the
 * transcript has recorded is appended rather than dropped, or a consumer folding `events()`
 * would disagree with `snapshot()`.
 *
 * ## The prose fallback, which used to reach nobody
 *
 * `Stop` carries `last_assistant_message`, and the adapter stores it precisely so a turn
 * whose transcript cannot be read still has SOMETHING to say. That store was never read
 * back out here, so the fallback existed and no consumer could see it: a completed turn
 * whose transcript had not flushed produced an empty report, the relay had nothing to route,
 * and the run ended on an escalation while the work sat on disk (#39).
 *
 * The transcript wins where it has text -- it concatenates every block, which is the full
 * narration the peer is entitled to, and `last_assistant_message` is only the closing
 * paragraph. The fallback applies exactly when there is nothing to lose by applying it.
 */
export function mergeKnownTurns(
  transcriptTurns: readonly TurnRecord[],
  known: readonly (KnownTurn | undefined)[],
): TurnRecord[] {
  const turns = [...transcriptTurns]
  known.forEach((k, i) => {
    if (!k) return
    const base = turns[i] ?? { key: k.key, prompt: k.prompt, state: 'in_progress' as const, toolCalls: [] }
    const merged: TurnRecord = { ...base, key: k.key }
    if (k.verdict) {
      merged.state = k.verdict.outcome
      merged.confidence = k.verdict.confidence
      merged.provenance = k.verdict.provenance
    }
    // Only when the transcript gave nothing. A partial narration is still the fuller
    // account, and replacing it with the closing paragraph would lose the rest of the turn.
    if (!merged.assistantText && k.assistantText) merged.assistantText = k.assistantText
    turns[i] = merged
  })
  return turns
}

export interface ClaudeAdapterOptions {
  cwd: string
  role: Role
  inputOwnership?: InputOwnership | undefined
  /** Extra CLI args, e.g. ['--permission-mode', 'default']. */
  args?: string[] | undefined
  /**
   * The program to spawn. Defaults to `claude` on PATH.
   *
   * Threaded from `AgentDefinition.launch.command` by the registry (#51), and that is the
   * point of it rather than a convenience: the availability preflight validates
   * `launch.command`, so an adapter that hardcodes its own filename makes the field a
   * DIFFERENT command from the one that launches -- an absolute path or a wrapper would be
   * checked and then not run. A validated field that nothing spawns is worse than no check,
   * because it reports on a configuration the run does not have.
   */
  command?: string | undefined
  readyTimeoutMs?: number | undefined
  /** How long an unmatched turn may run before the watchdog calls it uncertain. */
  watchdogMs?: number | undefined
  /**
   * How long a turn may produce nothing before it is called hung. Defaults to
   * `DEFAULT_IDLE_MS`.
   *
   * Configurable for the same reason `watchdogMs` is: the right value depends on the work.
   * It was also the only way to TEST the idle deadline against a real session -- a live proof
   * otherwise needs a turn that genuinely stalls for twelve minutes.
   */
  idleMs?: number | undefined
}

/**
 * What to tell an operator when a send is never acknowledged by a hook.
 *
 * The bare condition named an internal fact with no action attached, and it was the
 * last line a 12-turn run ever printed (issue #32). A diagnostic that ends a run
 * should say what to do about it.
 */
const SEND_HOOK_TIMEOUT =
  "no UserPromptSubmit hook after send, and the prompt IS in the child's transcript -- so the text was accepted and the hook is what did not arrive. Most often the previous turn had not finished -- neither CLI accepts input mid-turn -- so try a longer --settle. If it recurs at the first turn, the hooks are probably not firing at all: run `conclave config check`."

/**
 * The other half of the send failure, and the half that used to be reported as the one above.
 *
 * `#input.submit()` resolving means THIS PROCESS TYPED, not that the child received. When the
 * keystroke is swallowed the prompt never reaches the transcript, no hook can fire for a turn
 * that never started, and the old single message asserted "the child accepted the text" --
 * which was unverified, and in the observed case false (#120). It then named the hooks and
 * `--settle` as the remedies, the two things demonstrably working, and cost two runs
 * misattributed to other causes before anyone read the child's own transcript.
 *
 * Distinguishing the two costs one transcript read, which is already parsed and already polled.
 */
const SEND_NOT_ACCEPTED =
  "the text was typed but never became a prompt: it is absent from the child's transcript after a re-submit, so this is swallowed input rather than a hook failure. Nothing is wrong with the hooks -- `conclave config check` and `--settle` will not help. The turn was not started, so no work was lost."

/** How long to wait for a submitted prompt to appear in the transcript before repairing. */
const SUBMIT_LANDED_MS = 6_000

/** How long to wait after the repair keystroke before concluding the text never landed. */
const SUBMIT_REPAIR_MS = 6_000

/**
 * A pty buffer with escape sequences removed and whitespace collapsed.
 *
 * Shared, because there were two copies and they had already drifted: one wrote the OSC
 * alternative as an EMPTY character class followed by a literal bracket, which matches
 * nothing, so terminal-title writes survived into text that was then pattern-matched. A
 * title containing "trust this folder" would have been read as the folder-trust dialog.
 */
function plainScreen(raw: string): string {
  return raw
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]|\u001b[()][A-Z0-9]|\u001b[\]][^\u0007]*\u0007/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
}

/**
 * The folder-trust dialog, in the two phrasings Claude Code has used for it.
 *
 * Matched against a screen that has been through `plainScreen`: the raw buffer carries
 * cursor-positioning sequences BETWEEN words -- `trust\x1b[20Gthis\x1b[25Gfolder` -- so no
 * phrase appears contiguously and a naive regex silently never matches.
 */
const FOLDER_TRUST_DIALOG = /trust this folder|Is this a project you created/i

/**
 * Whether anything on screen LOOKS like the folder-trust dialog.
 *
 * Deliberately broad, and deliberately not the thing that authorises a keystroke. This is the
 * diagnostic reading: it runs once, after the readiness window has already expired, to explain a
 * failure that has already happened. Over-matching there costs a slightly wrong sentence in a
 * message nobody reads unless something is broken. See `answerableFolderTrustDialog` for the
 * reading that types.
 */
export function folderTrustDialogVisible(raw: string): boolean {
  return FOLDER_TRUST_DIALOG.test(plainScreen(raw).replace(/\s+/g, ' '))
}

/**
 * Every part of the dialog that must be on screen before anything is typed at it.
 *
 * The broad match above is not safe as a write gate, and the asymmetry is the whole point: a
 * false negative delays a boot that then fails with a message naming the remedy, while a false
 * positive types `1` and Enter into a live composer and submits a turn whose entire content is
 * `1`. A model that quotes the phrase "trust this folder" in its own narration, a file listing,
 * a diff of THIS source file on screen -- each of those satisfies the broad reading.
 *
 * So the structure is required, not the phrase:
 *
 *   1. the numbered accept option, `1. Yes, ... trust this folder`
 *   2. the numbered decline option, `2. No`
 *   3. the question, or the confirmation affordance the menu is drawn with
 *
 * The first is doing more work than pattern-matching. The keystroke this authorises is `1`, and
 * this is what checks that `1` is the option that TRUSTS -- rather than assuming an ordering
 * that lives in someone else's interface. On the day those swap, this stops matching and the
 * run fails with a diagnostic instead of confidently pressing "No, exit".
 */
const ANSWERABLE_SIGNATURE = [
  // The gap is bounded tightly on purpose. A screen is normalised to one long line -- the TUI
  // positions rows with cursor moves rather than newlines, so there are no line boundaries left
  // to anchor on -- and a generous bound lets `1. Yes, <another option> ... trust this folder`
  // satisfy this from two different options. In the real dialog the gap is ", I ".
  /(^|[^0-9])1\s*[.)]\s*Yes\b.{0,24}trust this folder/i,
  /(^|[^0-9])2\s*[.)]\s*No\b/i,
  /Is this a project you created|Enter to confirm/i,
] as const

/**
 * Whether the dialog is on screen AND has the shape this knows how to answer.
 *
 * The only reading that authorises a write. See `ANSWERABLE_SIGNATURE`.
 */
export function answerableFolderTrustDialog(raw: string): boolean {
  const screen = plainScreen(raw).replace(/\s+/g, ' ')
  return ANSWERABLE_SIGNATURE.every((re) => re.test(screen))
}

/**
 * A modal that is DISMISSED rather than answered, and why the two are different.
 *
 * Claude Code can raise setup modals mid-session. The one observed (#120) is
 * `/auto-mode-setup`, which appeared between an implementer's first and second turn and
 * silently ate every subsequent keystroke -- the text was typed, never became a prompt, and
 * the run died reporting a hook failure. It offers to scan shell history and other
 * repositories, so unlike the folder-trust gate this is NOT conclave's to accept: consenting
 * on an operator's behalf to reading their shell history is not implied by asking conclave to
 * drive a coding session in one directory.
 *
 * Esc is therefore the only key sent. It declines, it is the affordance the dialog itself
 * advertises, and it is inert if the match was wrong -- Esc at a live composer clears a draft
 * that this adapter did not put there, where Enter would submit one.
 *
 * Required structurally rather than by phrase, for the reason `ANSWERABLE_SIGNATURE` gives:
 * the title alone appears whenever a model narrates it or this file is on screen.
 */
const DISMISSABLE_MODAL = [
  /auto-mode-setup|Set up auto mode for your environment/i,
  /Esc to cancel/i,
] as const

/** Whether a setup modal conclave should decline is on screen. */
export function dismissableModalVisible(raw: string): boolean {
  const screen = plainScreen(raw).replace(/\s+/g, ' ')
  return DISMISSABLE_MODAL.every((re) => re.test(screen))
}

/**
 * What was sent to clear the dialog, recorded rather than left on a screen to be grepped.
 *
 * The keystrokes are part of the record on purpose. "The dialog was answered" and "option 1
 * was confirmed" are different claims, and the Codex equivalent shipped a version that
 * recorded the opposite of what it intended (`ensureTrust.ts`) precisely because the only
 * evidence kept was that a prompt had appeared.
 */
export interface FolderTrustAcceptance {
  /** The directory the dialog asked about: the session's cwd, verbatim. */
  directory: string
  /** Exactly what was written to the pty, in order. */
  keys: string[]
  at: number
}

/** The slice of a pty this needs, so the acceptance can be driven without spawning claude. */
export interface TrustDialogPty {
  readonly output: string
  write(data: string): void
}

/**
 * Answer Claude Code's folder-trust dialog once, selecting "Yes, I trust this folder".
 *
 * ## Why this is answered rather than reported
 *
 * It used to be reported: the adapter detected the dialog, refused, and told the operator to
 * run `claude` by hand. Under `--operator agent` there is by definition nobody who can carry
 * that out, so the run did not degrade -- it never started (#108). Nor is it a once-per-machine
 * cost: a directory that had been running Conclave for weeks began failing at startup the
 * moment Claude Code auto-updated, because whatever the update changed stopped the previous
 * acceptance from counting.
 *
 * The old comment argued that running Conclave in a directory is not the same as having vetted
 * what is in it. That reasoning does not survive what invoking Conclave for THIS directory
 * actually asks for: a Claude Code session in it, running Conclave's own hook client out of
 * this checkout, which Claude Code will not do until the folder is trusted. Refusing to answer
 * did not withhold the decision -- it withheld the session, and left the identical decision
 * for a human to make by hand with less information about it.
 *
 * ## What this does NOT grant
 *
 * Folder trust only, and for one directory: the one named in `directory`, which is the cwd the
 * session was launched in. It does not touch tool permissions. Every Read, Bash and Edit the
 * model asks for is still gated exactly as before, and `--dangerously-skip-permissions` remains
 * the only thing that changes that -- and, note, does NOT cover this dialog, which is why the
 * two are easy to confuse and why they are named together here.
 *
 * ## Once, and the `prior` argument is what makes that true
 *
 * The pty buffer is CUMULATIVE. The dialog text stays in it forever, so a caller polling until
 * the session is ready sees it on every pass after the first -- and a second pass would type
 * `1` and Enter into a live composer, submitting a turn whose entire content is `1`. Passing
 * back the acceptance already held is what stops that, so it is a parameter rather than a rule
 * in the caller's head. Returns `prior` unchanged and writes nothing when it is set.
 *
 * The other half of that guard is `answerableFolderTrustDialog`, which requires the whole menu
 * rather than a phrase: `prior` stops a SECOND write, and the signature stops a first one at a
 * screen that merely mentions trusting a folder.
 */
export async function acceptFolderTrustDialog(
  pty: TrustDialogPty,
  directory: string,
  opts: { prior?: FolderTrustAcceptance | undefined; settleMs?: number; now?: () => number } = {},
): Promise<FolderTrustAcceptance | undefined> {
  if (opts.prior) return opts.prior
  // The strict reading, never the broad one. Nothing is typed at a screen whose structure has
  // not been confirmed, including the position of the option about to be pressed.
  if (!answerableFolderTrustDialog(pty.output)) return undefined
  // The same shape as the Codex prompt driver: settle, select, settle, confirm. A TUI that
  // is still drawing drops keys, and both halves have been observed to need the gap.
  const settle = opts.settleMs ?? 400
  const keys: string[] = []
  const send = async (k: string) => {
    await new Promise((r) => setTimeout(r, settle))
    pty.write(k)
    keys.push(k)
  }
  await send('1') // "1. Yes, I trust this folder"
  await send('\r')
  return { directory, keys, at: (opts.now ?? Date.now)() }
}

/**
 * Why the session never became ready, in terms the operator can act on.
 *
 * Exported and pure so the message can be tested against the states that produce it, rather
 * than by driving a real `claude` into each of them.
 *
 * Three states read identically from outside and are separated here, because what the operator
 * should do differs in each:
 *
 *   answered, still stuck   the acceptance ran and did not take. Says exactly what it sent, so
 *                           the next person is debugging the acceptance rather than rediscovering
 *                           that there is one. The by-hand remedies are still given: a human at a
 *                           terminal can do what the automation could not, which is the whole
 *                           asymmetry, and withholding them would leave a stuck run with nothing.
 *   visible, unanswerable   the dialog is up in a shape the signature does not cover, so nothing
 *                           was typed at it ON PURPOSE. That is the actionable news, because it
 *                           says the acceptance needs teaching a new shape rather than that it is
 *                           broken.
 *   visible, never answered the acceptance did not run at all -- an older build, or a code path
 *                           that skipped it.
 */
export function bootFailureMessage(state: {
  screen: string
  cwd: string
  alive: boolean
  trust?: FolderTrustAcceptance | undefined
}): string {
  // `claude -p` is named because it is the first thing anyone reaches for, and it is the one
  // check that cannot see this: headless mode never shows the dialog, so it returns a cheerful
  // OK in the very directory where every interactive session is stuck (#108).
  const notATest =
    'Note that `claude -p "say OK"` is NOT a valid test of this condition -- headless mode ' +
    'never shows the dialog -- and --dangerously-skip-permissions does NOT cover it.'
  if (state.trust) {
    return (
      `claude showed its folder-trust dialog for ${state.trust.directory} and conclave answered ` +
      `it (sent ${state.trust.keys.map((k) => (k === '\r' ? 'Enter' : k)).join(' then ')}), but ` +
      'the session still never reported SessionStart, so the acceptance did not take. Run ' +
      `\`claude\` in that directory once and accept it by hand, or set projects["${state.cwd}"]` +
      '.hasTrustDialogAccepted to true in ~/.claude.json. ' +
      notATest
    )
  }
  if (folderTrustDialogVisible(state.screen)) {
    const remedy =
      'run `claude` in that directory once and accept, or set ' +
      `projects["${state.cwd}"].hasTrustDialogAccepted to true in ~/.claude.json. ${notATest}`
    // Nothing was typed, and saying so is the point. The signature requires the menu it is about
    // to press a key on -- `1. Yes, ... trust this folder` and `2. No` -- precisely so that an
    // unfamiliar screen produces this message instead of a keystroke of unknown meaning.
    if (!answerableFolderTrustDialog(state.screen)) {
      return (
        `claude is waiting on its folder-trust dialog for ${state.cwd}, so no hook can fire and ` +
        'the session never becomes ready. Conclave did NOT answer it: the dialog is on screen in ' +
        'a shape it does not recognise, and it will not press a numbered option whose meaning it ' +
        `has not confirmed. ${remedy}`
      )
    }
    return (
      `claude is waiting on its folder-trust dialog for ${state.cwd}, so no hook can fire and ` +
      'the session never becomes ready. Conclave answers this dialog itself, so seeing it here ' +
      `means the acceptance never ran: ${remedy}`
    )
  }
  if (!state.alive) {
    return 'claude exited before reporting SessionStart; run `conclave config check` to verify the hook registration'
  }
  return (
    'claude did not report SessionStart within the readiness window. The hooks may not be ' +
    'registered: run `conclave config check`. If it is merely slow, raise readyTimeoutMs.'
  )
}

export class ClaudePtyHookAdapter implements AgentSession {
  readonly agent = 'claude'
  readonly guarantees: Guarantees

  #pty!: PtyProcess
  #input!: InputQueue
  #receiver!: HookReceiver
  #events = new AsyncQueue<AgentEvent>()
  #turns = new Map<string, TurnState>()
  #order: string[] = []
  #view: TranscriptSessionView | undefined
  #sessionId = ''
  #transcriptPath: string | undefined
  #seq = 0
  #ready = false
  #closed = false
  #closeMode: 'graceful' | 'abandoned' | undefined
  #pendingPrompt: { resolve: (k: TurnKey) => void; reject: (e: Error) => void; prompt: string } | undefined
  #opts: ClaudeAdapterOptions
  #folderTrust: FolderTrustAcceptance | undefined
  #notices: string[] = []
  #settingsDir: string | undefined
  #watchdog: TurnWatchdog<TurnState>

  private constructor(opts: ClaudeAdapterOptions) {
    this.#opts = opts
    this.guarantees = guaranteesFor(opts.inputOwnership ?? 'mediated')
    // A hung turn produces no hooks, no transcript records and no exit, so the deadline
    // rule has to be driven by a clock rather than by an arrival like everything else.
    // `synthesized: true` -- nothing from the child said this.
    this.#watchdog = new TurnWatchdog<TurnState>(
      opts.watchdogMs ?? DEFAULT_WATCHDOG_MS,
      (turn, update) => this.#apply(turn, this.#withScreenTail(update), true),
      opts.idleMs,
    )
  }


  /** The pty's child, so a quiet turn can be told from a dead one. See `outcomes/liveness`. */
  get childPid(): number | undefined {
    return this.#pty?.pid
  }

  get sessionId(): string {
    return this.#sessionId
  }

  /** SessionStart has arrived: the session exists and its transcript path is known. */
  get isReady(): boolean {
    return this.#ready
  }

  /**
   * Separate capability from readiness on purpose. SessionStart can arrive before the
   * composer is drawn, and it blocks the first turn until it returns (measured in spike
   * 2: 2.1s baseline vs 10.0s with the hook stalled to its timeout). Readiness says the
   * session exists; this says keystrokes will land.
   */
  get acceptsInput(): boolean {
    return this.#pty?.alive === true && this.#pty.isInteractive
  }

  static async start(opts: ClaudeAdapterOptions): Promise<ClaudePtyHookAdapter> {
    const self = new ClaudePtyHookAdapter(opts)
    await self.#boot()
    return self
  }

  async #boot(): Promise<void> {
    const runDir = mkdtempSync(join(tmpdir(), 'orch-claude-'))
    this.#settingsDir = runDir

    this.#receiver = new HookReceiver(join(runDir, 'hooks.ndjson'))
    const url = await this.#receiver.start()
    this.#receiver.on('delivery', (d) => this.#onHook(d))
    // Replays are visible rather than silent: a duplicate means recovery ran.
    this.#receiver.on('duplicate', (d) =>
      this.#emit({
        type: 'error',
        message: `replayed hook delivery ${d.deliveryId} (${d.event}); ignored`,
        fatal: false,
        seq: this.#next(),
        at: Date.now(),
        provisional: false,
      }),
    )

    // A dedicated settings file rather than editing the project's: the adapter must not
    // mutate a user's configuration to do its job.
    const settingsPath = join(runDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify(this.#hookSettings(), null, 2))

    const env = sanitizedCopy(process.env as Record<string, string>, {
      extra: {
        ORCH_HOOK_URL: url,
        ORCH_HOOK_ATTEMPT_JOURNAL: join(runDir, 'attempts.ndjson'),
        ORCH_HOOK_TIMEOUT_MS: '5000',
      },
    })

    this.#pty = await PtyProcess.spawn({
      file: this.#opts.command ?? 'claude',
      args: ['--settings', settingsPath, ...(this.#opts.args ?? [])],
      cwd: this.#opts.cwd,
      env,
    })
    this.#input = new InputQueue(this.#pty)
    this.#pty.on('exit', (info) => void this.#onExit(info.reason))

    const deadline = Date.now() + (this.#opts.readyTimeoutMs ?? 60_000)
    while (!this.#ready && Date.now() < deadline && this.#pty.alive) {
      // Inside the readiness wait rather than before it: the dialog is drawn by the very
      // process we are waiting on, and until it is answered no hook fires, so waiting and
      // watching for it are the same activity.
      await this.#answerFolderTrust()
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!this.#ready) throw new Error(this.#whyNotReady())
    // Readiness is not the same as being able to type; wait for both.
    await this.#pty.waitForOutput(() => this.#pty.isInteractive, 30_000)
    await this.#pty.waitQuiet(700, 20_000)
  }

  /**
   * Answer the folder-trust dialog if it is on screen, at most once per session.
   *
   * The commonest reason a session never becomes ready: Claude Code shows this on any
   * directory it has not seen -- including under `--dangerously-skip-permissions`, which does
   * not cover it -- and nothing proceeds until it is answered, so no hook ever fires and the
   * failure looks identical to a broken hook registration.
   *
   * Announced through `startupNotices` rather than an event: the events emitted during boot
   * are buffered and drained when the relay attaches, which is before either front-end
   * subscribes to the activity stream, so a notice sent that way is a notice nobody prints.
   * The relay records these in the routing log, which both front-ends do print and the run
   * record keeps.
   */
  async #answerFolderTrust(): Promise<void> {
    const accepted = await acceptFolderTrustDialog(this.#pty, this.#opts.cwd, {
      prior: this.#folderTrust,
    })
    // Identity, not truthiness: `accepted` is the acceptance that now STANDS, which on every
    // pass after the first is the one already held. Only a new one is announced.
    if (!accepted || accepted === this.#folderTrust) return
    this.#folderTrust = accepted
    // The exact directory, because that is the whole content of the decision and it is not
    // always the one the operator is looking at: a seat working in an isolated worktree is
    // launched in the tree's path, not the checkout the run was started from.
    this.#notices.push(
      `accepted claude's folder-trust dialog for ${accepted.directory} — this grants folder ` +
        'trust only and does not bypass tool permissions',
    )
  }

  /** See `#answerFolderTrust`: what happened at boot that the operator must be told about. */
  get startupNotices(): readonly string[] {
    return this.#notices
  }

  /** Why the session never became ready. See `bootFailureMessage`. */
  #whyNotReady(): string {
    return bootFailureMessage({
      screen: this.#pty?.output ?? '',
      cwd: this.#opts.cwd,
      alive: this.#pty?.alive === true,
      trust: this.#folderTrust,
    })
  }

  /**
   * Attach what the terminal was showing when a turn was declared hung.
   *
   * The adapter reads the TRANSCRIPT, so anything the CLI reports on screen and never writes
   * to the transcript is invisible to it -- and a turn that died on an API error looks
   * identical to one that simply went quiet. That is not hypothetical for this project: the
   * Codex equivalent was `usage_limit_exceeded` arriving as a `task_complete` error and being
   * read as a normal empty completion (#35).
   *
   * A stalled turn is exactly when that difference matters and exactly when nobody can go and
   * look, because unattended runs are the ones that stall. So the last of the screen travels
   * with the verdict, as a caveat: it is context for a human, never evidence for a decision.
   *
   * Bounded and escape-stripped. The raw buffer is megabytes of cursor positioning, and the
   * useful part is the last few lines.
   */
  #withScreenTail(update: VerdictUpdate | undefined): VerdictUpdate | undefined {
    if (!update?.verdict) return update
    const screen = plainScreen(this.#pty?.output ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-6)
      .join(' / ')
    if (!screen) return update
    return {
      ...update,
      verdict: {
        ...update.verdict,
        provenance: [
          ...update.verdict.provenance,
          { source: 'transport', detail: `terminal showed: ${screen.slice(-400)}`, caveat: true },
        ],
      },
    }
  }

  #hookSettings(): unknown {
    const command = `node ${CLIENT} claude`
    const entry = { hooks: [{ type: 'command', command, timeout: 10 }] }
    return { hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [entry]])) }
  }

  #next(): number {
    return ++this.#seq
  }

/**
   * Tail the transcript while a turn is in flight, so its events exist while they matter.
   *
   * The transcript view emits `message` deltas and `tool_use` as they appear — the running
   * commentary a watching human wants, and the per-participant evidence attribution needs.
   * Nothing was calling it during a turn: `#view.poll()` ran only inside `snapshot()`, which
   * the relay calls at turn boundaries. So every transcript-derived event materialised in a
   * burst AFTER the turn ended, and "live activity" was live in name only.
   *
   * The fan-out in `relay/observe.ts` was built for exactly this stream and had nothing
   * feeding it. Found by a human saying they could not see the implementer working.
   *
   * Unref'd, and serialized against itself: two concurrent polls would read the same tail
   * offset twice. `snapshot()` shares the view, so a poll in flight is awaited rather than
   * duplicated.
   */
  #tailTimer: NodeJS.Timeout | undefined
  #polling: Promise<void> | undefined

  async #pollTranscript(): Promise<void> {
    if (!this.#view) return
    if (this.#polling) return this.#polling
    this.#polling = (async () => {
      try {
        for (const e of await this.#view!.poll()) {
          // CONTENT ONLY. The view also derives `turn_start` and `turn_end` from the
          // transcript, and those are the hooks' job: `Stop` proves completion, a parsed
          // `stop_reason` merely suggests it. Emitting both put two lifecycle events in one
          // stream — the console started the status twice per turn, and worse, `#exchange`
          // waits for the FIRST turn_end after a send, so a transcript-derived one could
          // end an exchange before the authoritative verdict existed.
          //
          // Until this poller existed the view's events were never emitted at all, so the
          // duplication had nowhere to show up.
          if (e.type === 'turn_start' || e.type === 'turn_end') continue
          this.#emit(e)
        }
      } catch {
        // Unreadable mid-write is ordinary; the next tick picks it up.
      } finally {
        this.#polling = undefined
      }
    })()
    return this.#polling
  }

  #startTailing(): void {
    if (this.#tailTimer) return
    this.#tailTimer = setInterval(() => void this.#pollTranscript(), TAIL_INTERVAL_MS)
    this.#tailTimer.unref()
  }

  #stopTailing(): void {
    if (this.#tailTimer) clearInterval(this.#tailTimer)
    this.#tailTimer = undefined
  }

  #emit(e: AgentEvent): void {
    // Any event is a sign of life for its turn, so the idle deadline moves with it. Without
    // this the only clock is the absolute one, and a turn that goes silent mid-work waits it
    // out in full -- issue #36, where a session sat idle ~44 minutes producing nothing.
    // `touchAll`, not `touch(e.turnKey)`: the key on an event depends on what produced it,
    // and a transcript-sourced event does not carry the hook key the watchdog is armed under.
    if (e.type !== 'turn_end') this.#watchdog.touchAll()
    // The child SPOKE, as opposed to the turn merely existing. `turn_start` is this adapter
    // announcing that it armed a clock, and `revision`/`error` are this adapter reporting on
    // itself; none of the three is evidence the child produced anything. Recorded once per
    // turn -- the tracker is asked only on the transition -- because this runs on the hot
    // event path, and because a repeat says nothing the first one did not.
    if (CHILD_OUTPUT.has(e.type)) {
      const turn = this.#latestLiveTurn()
      if (turn && !turn.produced) {
        turn.produced = true
        turn.tracker.observeLaunch({ produced: true })
      } else if (!turn) {
        // The child spoke before its own UserPromptSubmit reached us. Hooks are delivered as
        // independent POSTs that nobody orders, so a CLI that fires a permission request
        // immediately after submitting a prompt can have the two arrive either way round --
        // reliably in order on one machine and not on another, which is how this was found:
        // green on macOS, red on Linux, on the same commit.
        //
        // Dropping it is not neutral. It is the difference between "this turn produced
        // nothing, so the model it was launched with is a suspect" and the opposite, so
        // losing the race makes conclave blame a model for a turn that spoke (#82).
        this.#producedBeforeTurn = true
      }
    }
    this.#events.push(e)
  }

  /**
   * A child-output event arrived with no live turn to attribute it to.
   *
   * Consumed by the next turn this session opens, once. Not a queue: what matters is only
   * whether the child has spoken at all, and a second early event says nothing the first
   * did not.
   */
  #producedBeforeTurn = false

  #turnFor(key: string): TurnState | undefined {
    return this.#turns.get(key)
  }

  #onHook(d: HookDelivery): void {
    switch (d.event) {
      case 'SessionStart': {
        this.#sessionId = d.sessionId ?? ''
        this.#transcriptPath = d.payload.transcript_path
        if (this.#transcriptPath) {
          this.#view = new TranscriptSessionView({
            path: this.#transcriptPath,
            agent: 'claude',
            sessionId: this.#sessionId,
            cwd: this.#opts.cwd,
            guarantees: this.guarantees,
          })
        }
        this.#ready = true
        return
      }
      case 'UserPromptSubmit': {
        const key = turnKey(String(d.turnKey ?? `unkeyed-${this.#order.length}`))
        const tracker = new TurnVerdictTracker({
          agent: this.agent,
          orchestrator: {
            sentCancel: false,
            inputIsMediated: this.guarantees.inputOwnership === 'mediated',
          },
          watchdogSeconds: (this.#opts.watchdogMs ?? DEFAULT_WATCHDOG_MS) / 1000,
          // What this child was started with, so a deadline that fires on a turn which never
          // produced anything can name the model as a candidate cause (#82). `#order` is empty
          // for exactly one turn per session, which is the only turn the launch is a suspect on.
          launch: { model: modelFromArgs(this.#opts.args ?? []), firstTurn: this.#order.length === 0, produced: false },
        })
        tracker.observeHook('UserPromptSubmit', d.payload)
        const turn: TurnState = {
          key,
          prompt: String(d.payload.prompt ?? ''),
          startedAt: Date.now(),
          tracker,
          endSeq: undefined,
          assistantText: undefined,
          produced: false,
        }
        if (this.#producedBeforeTurn) {
          this.#producedBeforeTurn = false
          turn.produced = true
          turn.tracker.observeLaunch({ produced: true })
        }
        this.#turns.set(String(key), turn)
        this.#order.push(String(key))
        this.#watchdog.arm(String(key), turn)
        // A turn is running: tail the transcript so its narration and tool use exist while
        // they are useful, not in a burst after it ends.
        this.#startTailing()
        this.#emit({
          type: 'turn_start',
          prompt: turn.prompt,
          turnKey: key,
          seq: this.#next(),
          at: turn.startedAt,
          provisional: false,
        })
        this.#pendingPrompt?.resolve(key)
        this.#pendingPrompt = undefined
        return
      }
      case 'PermissionRequest': {
        const turn = this.#latestLiveTurn()
        if (turn) this.#apply(turn, turn.tracker.observeHook('PermissionRequest', d.payload), true)
        this.#emit({
          type: 'permission_requested',
          tool: String(d.payload.tool_name ?? 'unknown'),
          input: d.payload.tool_input,
          turnKey: turn?.key,
          seq: this.#next(),
          at: Date.now(),
          provisional: false,
        })
        return
      }
      case 'Stop': {
        const key = String(d.turnKey ?? '')
        // A Stop may arrive for a turn already settled by other evidence; the tracker
        // decides whether it changes anything, rather than a guard here deciding it is
        // too late to matter.
        const turn = this.#turnFor(key) ?? this.#latestSettleableTurn()
        if (!turn) return
        // Fallback only. The peer is entitled to the full narration, which lives in the
        // transcript; this is the closing paragraph and is used until reconciliation
        // replaces it, or permanently if the transcript is unreadable.
        if (d.payload.last_assistant_message && !turn.assistantText) {
          turn.assistantText = String(d.payload.last_assistant_message)
        }
        this.#apply(turn, turn.tracker.observeHook('Stop', d.payload), false)
        return
      }
      case 'SessionEnd': {
        // Session-level, not turn-level. Recorded as evidence on turns still open.
        for (const t of this.#liveTurns()) {
          this.#apply(t, t.tracker.observeHook('SessionEnd', d.payload), true)
        }
        return
      }
    }
  }

  #allTurns(): TurnState[] {
    return this.#order.map((k) => this.#turns.get(k)!).filter(Boolean)
  }

  #liveTurns(): TurnState[] {
    return this.#allTurns().filter((t) => !t.tracker.settled)
  }

  #latestLiveTurn(): TurnState | undefined {
    return this.#liveTurns().at(-1)
  }

  /** Most recent turn, settled or not -- late evidence may still revise a settled one. */
  #latestSettleableTurn(): TurnState | undefined {
    return this.#liveTurns().at(-1) ?? this.#allTurns().at(-1)
  }

  /**
   * Emit whatever a tracker update implies: a `revision` withdrawing the previous
   * `turn_end` when one is superseded, then the new terminal event.
   *
   * This is the whole point of the migration. A verdict already reported to consumers is
   * withdrawn by number rather than left standing beside its own contradiction.
   */
  #apply(turn: TurnState, update: VerdictUpdate | undefined, synthesized: boolean): void {
    if (!update) return

    // A settled turn releases its watchdog target. `disarm` keeps the target on purpose so
    // `touch` can re-arm a live turn, so something has to let go or every TurnState ever
    // armed -- with its tracker, provenance and assistant text -- is retained until the
    // session ends. A long interactive session accumulates one per turn.
    this.#watchdog.forget(String(turn.key))

    if (update.supersedes && turn.endSeq !== undefined) {
      this.#emit({
        type: 'revision',
        reason: 'late_signal',
        replaces: [turn.endSeq],
        provenance: [
          {
            source: 'hook',
            detail:
              `stronger evidence superseded ${update.supersedes.outcome}` +
              (update.verdict ? ` with ${update.verdict.outcome}` : ' with no verdict'),
          },
          ...(update.verdict?.provenance ?? []),
        ],
        seq: this.#next(),
        at: Date.now(),
        provisional: false,
      })
      turn.endSeq = undefined
    }

    if (!update.verdict) return // withdrawn without replacement; the turn is open again

    const seq = this.#next()
    turn.endSeq = seq
    // One last read before standing down, so the closing message is not left for the next
    // turn's tail to discover.
    this.#stopTailing()
    void this.#pollTranscript()
    this.#emit({
      type: 'turn_end',
      verdict: update.verdict,
      synthesized,
      turnKey: turn.key,
      seq,
      at: Date.now(),
      provisional: false,
    })
  }

  #lastPermissionDecision(since: number): 'allow' | 'deny' | undefined {
    const a = this.#input.last('permission_decision')
    if (!a || a.at < since) return undefined
    return a.detail?.startsWith('deny') ? 'deny' : 'allow'
  }

  /**
   * Rebuild transcript evidence for every turn from the transcript as it CURRENTLY
   * stands, and let each tracker re-decide.
   *
   * `resetTranscript` rather than `observeTranscript` on purpose. Everywhere else
   * evidence accumulates, which is what stops weaker repeated signals resurrecting a
   * verdict. Compaction breaks that: a rewritten transcript may no longer contain a
   * record a tracker already saw, and holding it would assert something the source of
   * truth now denies. Hook and orchestrator evidence survive untouched -- those channels
   * were not rewritten.
   *
   * This is also what stops a lost `Stop` from becoming `process_exited` at shutdown: an
   * assistant entry with stop_reason=end_turn is correlation evidence that the turn
   * completed even though its hook never arrived.
   */
  async #reconcileFromTranscript(): Promise<void> {
    if (!this.#view) return

    let snap: SessionSnapshot
    try {
      snap = await this.#view.snapshot()
    } catch {
      return // transcript unreadable; leave existing evidence alone rather than guess
    }
    const completedInTranscript = snap.turns.filter((t) => t.state === 'completed').length

    // Only as many turns as the transcript actually evidences may claim completion.
    let credits = Math.max(0, completedInTranscript - this.#provenCompletedCount())

    this.#allTurns().forEach((turn, i) => {
      // The peer receives ALL prose, not just the closing message, so the transcript is
      // the source of truth here: parseClaude concatenates every text block in the turn,
      // which is the running narration a reader following along actually sees. The Stop
      // hook's last_assistant_message is only the final paragraph, and is kept as a
      // fallback for when the transcript cannot be read. Claude Code writes no per-turn
      // id, so correspondence is positional.
      const narration = snap.turns[i]?.assistantText
      if (narration) turn.assistantText = narration

      const recovered = !turn.tracker.evidence.hooks.includes('Stop') && credits > 0
      if (recovered) credits--
      const update = turn.tracker.resetTranscript({
        ...emptyTranscriptState(),
        exists: true,
        hasAssistantAfterPrompt: recovered,
        finalStopReason: recovered ? 'end_turn' : undefined,
      })
      this.#apply(turn, update, true)
    })
  }

  /** Turns whose completion is proven by a Stop, so they need no transcript credit. */
  #provenCompletedCount(): number {
    return this.#allTurns().filter((t) => t.tracker.evidence.hooks.includes('Stop')).length
  }

  async #onExit(reason: string): Promise<void> {
    // Every outstanding command promise must resolve; a caller awaiting send() when the
    // child dies would otherwise hang forever.
    this.#pendingPrompt?.reject(new Error(`claude exited (${reason}) before accepting the prompt`))
    this.#pendingPrompt = undefined

    // The child is gone: whatever the turns are, they are not still running. The deadline
    // has nothing left to say and must not fire against a dead session.
    this.#watchdog.disarmAll()

    await this.#reconcileFromTranscript()
    for (const turn of this.#liveTurns()) {
      this.#apply(
        turn,
        turn.tracker.observeProcess({ alive: false, howEnded: this.#pty.exitInfo?.reason }),
        true,
      )
    }

    if (!this.#closed) {
      this.#emit({
        type: 'error',
        message: `child exited unexpectedly (${reason})`,
        fatal: true,
        seq: this.#next(),
        at: Date.now(),
        provisional: false,
      })
    }
    this.#events.close()
  }

  // --- AgentSession ---------------------------------------------------------------


  #state: SessionState = 'running'

  get state(): SessionState {
    return this.#state
  }

  /**
   * Stop accepting work; stay alive and keep the context.
   *
   * Deliberately does not touch the PTY. A quiesced session is one a replacement may have
   * to be rolled back to, so nothing about it may be discarded -- not the process, not the
   * transcript, not the trackers. The only change is that `send()` refuses.
   */
  async quiesce(): Promise<void> {
    if (this.#state === 'terminated') throw new Error('cannot quiesce a terminated session')
    await this.#input.drain()
    this.#state = 'quiesced'
  }

  /** The rollback path: return a quiesced session to service. */
  async unquiesce(): Promise<void> {
    if (this.#state === 'terminated') throw new Error('cannot unquiesce a terminated session')
    this.#state = 'running'
  }

  async beginRotation(): Promise<void> {
    if (this.#state !== 'quiesced') {
      throw new Error(`cannot begin rotation from '${this.#state}': quiesce the session first`)
    }
    this.#state = 'rotating'
  }

  async send(message: string, _provenance: SendProvenance): Promise<TurnKey> {
    if (this.#state !== 'running') {
      throw new Error(`session is ${this.#state}; it is not accepting work`)
    }
    if (!this.acceptsInput) throw new Error('session is not accepting input')
    const keyed = new Promise<TurnKey>((resolve, reject) => {
      this.#pendingPrompt = { resolve, reject, prompt: message }
    })
    // Serialized against cancel() and decidePermission() by the shared queue.
    const before = await this.#promptOccurrences(message)
    await this.#input.submit(message)

    // Did it actually arrive? `submit()` resolving means this process TYPED -- the pty took the
    // bytes -- and says nothing about whether the child turned them into a prompt. Observed on
    // this repository (#120): a second send was typed, never became a prompt, and the failure was
    // reported as a hook problem because nothing had checked. The child's transcript is the
    // independent witness, already parsed and already polled, and it does not depend on the hook
    // path being healthy to answer.
    //
    // The repair is a bare Enter, not a re-send of the text. If the composer holds the message and
    // only the submit keystroke was swallowed, Enter completes it; if the text never landed either,
    // Enter is a no-op on an empty composer. Re-sending the text could not tell those apart and
    // would concatenate in the first case, which is why the verification comes first and the
    // repair is the weaker action rather than the more thorough one.
    // Only when the hook is LATE. A healthy send resolves here in well under a second, and
    // making every send wait for the transcript to catch up would tax the common path to
    // diagnose the rare one -- the transcript settles behind the hook by design, so it is the
    // slower of the two witnesses and must not gate the faster.
    const early = await Promise.race([
      keyed.then(() => 'hooked' as const),
      new Promise<'late'>((r) => setTimeout(() => r('late'), SUBMIT_LANDED_MS)),
    ])
    if (early === 'late' && !(await this.#promptLanded(message, before, 0))) {
      // A modal ate it. Checked before either repair, because both of them type at whatever has
      // focus, and typing a prompt into a settings dialog is how a keystroke gets turned into a
      // configuration change nobody asked for. Esc declines and returns focus to the composer.
      if (dismissableModalVisible(this.#pty?.output ?? '')) {
        await this.#input.cancel('Esc: declining a setup modal that was blocking input')
        this.#emit({
          type: 'error',
          message:
            'declined a Claude Code setup modal that was blocking input (Esc). It was not accepted: it offers to read shell history and other repositories, which is not conclave\'s to agree to.',
          fatal: false,
          seq: this.#next(),
          at: Date.now(),
          provisional: false,
        })
        await new Promise((r) => setTimeout(r, 500))
        await this.#input.submit(message, 're-typed: a setup modal had swallowed the send')
        if (await this.#promptLanded(message, before, SUBMIT_REPAIR_MS)) return await keyed
      }
      await this.#input.submit('', 'bare Enter: prompt had not reached the transcript')
      if (!(await this.#promptLanded(message, before, SUBMIT_REPAIR_MS))) {
        // Now, and only now, re-type the whole message. The two checks above have established
        // what makes this safe: the text is not in the composer, because if it were, the bare
        // Enter would have submitted it and the transcript would show a turn. So there is
        // nothing to concatenate with. Observed live on #120 -- a swallowed second send leaves
        // the composer empty rather than holding an unsubmitted line, so the weaker repair
        // cannot recover it and the stronger one cannot duplicate.
        await this.#input.submit(message, 're-typed: composer was empty after bare Enter')
        if (!(await this.#promptLanded(message, before, SUBMIT_REPAIR_MS))) {
          throw new Error(SEND_NOT_ACCEPTED)
        }
      }
    }

    // Cleared on the way out: the loser of the race is a live 30s timer, and leaving it
    // pending keeps the event loop alive long after the send resolved.
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(SEND_HOOK_TIMEOUT)), 30_000)
    })
    try {
      return await Promise.race([keyed, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * How many turns the child's transcript shows whose prompt is EXACTLY this message.
   *
   * `undefined` before the view exists, which is correct rather than convenient: a send before
   * the transcript is readable cannot be verified, and `#promptLanded` treats "cannot see" as
   * "landed" so an unverifiable send behaves exactly as it did before this check existed.
   *
   * A count of matches rather than an index, because the transcript is not append-only from
   * this side of it: a compaction rewrites the view, and an index captured before a send would
   * point somewhere else afterwards. A count of a specific string survives that, and it also
   * gives the right answer for the case an index cannot express -- the same instruction sent
   * twice, where the second send's witness is a SECOND occurrence and not the first one.
   */
  async #promptOccurrences(message: string): Promise<number | undefined> {
    if (!this.#view) return undefined
    try {
      return (await this.#view.snapshot()).turns.filter((t) => t.prompt === message).length
    } catch {
      return undefined
    }
  }

  /**
   * Whether THIS prompt has appeared in the transcript since `before`, polled until `budgetMs`.
   *
   * The count used to be of turns, not of this prompt, and that is a different claim: it says
   * the transcript grew, and a transcript grows for reasons that have nothing to do with the
   * send. The case that matters is the one this check exists for -- a prior turn that ended
   * UNCERTAIN and is in fact still generating. Such a turn goes on appending to the transcript
   * while the new prompt is being typed into a child that is not accepting input, so a
   * turn-count check sees growth, calls the send landed, and hands back the exact false
   * positive #120 was about: the text was swallowed, nothing is wrong with the hooks, and the
   * run is told the child accepted it.
   *
   * Matching the prompt text is what makes the witness independent of the prior turn. Nothing
   * the still-generating turn writes carries the new message as its `prompt`.
   */
  async #promptLanded(message: string, before: number | undefined, budgetMs: number): Promise<boolean> {
    // No baseline means no view, and a check that cannot run must not fail the send.
    if (before === undefined) return true
    const deadline = Date.now() + budgetMs
    for (;;) {
      const now = await this.#promptOccurrences(message)
      if (now === undefined || now > before) return true
      if (Date.now() >= deadline) return false
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  async cancel(): Promise<TurnKey | undefined> {
    const turn = this.#latestLiveTurn()
    await this.#input.cancel(turn ? String(turn.key) : 'no live turn')
    if (!turn) return undefined
    // Cancellation produces no signal from the child at all. Give the UI a moment to
    // settle, then conclude from our own record of having sent ESC -- which is why the
    // input queue's semantic action log is classification evidence, not a debug aid.
    await new Promise((r) => setTimeout(r, 1500))
    this.#apply(turn, turn.tracker.observeOrchestrator({ sentCancel: true }), true)
    return turn.key
  }

  async decidePermission(decision: 'allow' | 'deny'): Promise<void> {
    if (this.guarantees.inputOwnership !== 'mediated') {
      throw new Error('permission decisions require mediated input ownership')
    }
    const action = await this.#input.decidePermission(decision)
    // The decision is evidence: on both agents a refused permission is otherwise
    // indistinguishable from a user cancellation.
    const turn = this.#latestSettleableTurn()
    if (turn) {
      this.#apply(
        turn,
        turn.tracker.observeOrchestrator({ sentPermissionDecision: decision }),
        true,
      )
    }
    void action
  }

  events(): AsyncIterable<AgentEvent> {
    return this.#events
  }

  async snapshot(): Promise<SessionSnapshot> {
    if (!this.#view) {
      return {
        sessionId: this.#sessionId,
        agent: this.agent,
        cwd: this.#opts.cwd,
        role: this.#opts.role,
        turns: [],
        guarantees: this.guarantees,
        compactionGeneration: 0,
        builtAt: Date.now(),
      }
    }
    const snap = await this.#view.snapshot()

    const turns = mergeKnownTurns(
      snap.turns,
      this.#order.map((key) => {
        const known = this.#turns.get(key)
        if (!known) return undefined
        return {
          key: known.key,
          prompt: known.prompt,
          assistantText: known.assistantText,
          verdict: known.tracker.verdict,
        }
      }),
    )
    return { ...snap, turns, role: this.#opts.role }
  }

  async fork(): Promise<AgentSession> {
    throw new Error('fork() not implemented for the PTY adapter yet')
  }

  /**
   * Graceful shutdown, distinguished from transport abandonment. Cleanup must not
   * manufacture an outcome: turns are reconciled against the transcript first, so a
   * completed turn whose Stop was lost is recovered rather than reported as a death.
   */
  async close(mode: 'graceful' | 'abandoned' = 'graceful'): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#closeMode = mode
    // The queue is closed in a `finally`, so a close that THROWS still ends the iteration (#143).
    // Everything between here and there can reject -- draining stdin, reconciling the transcript,
    // terminating the pty, stopping the receiver -- and `#closed` is already true above, so a
    // caller that retries returns immediately without ever reaching this line. The relay waits for
    // its forwarder to drain before it abandons a turn, and a queue that never ends turns that
    // wait into the hang it was added to remove: the one path least able to afford it, again.
    try {
      // Before either branch: we are done observing, so the deadline stops applying. Left
      // armed it could fire during the awaits below and race the verdict each branch is
      // deliberately choosing.
      this.#watchdog.disarmAll()

      if (mode === 'graceful' && this.#pty.alive) {
        await this.#input.drain()
        // Reconcile BEFORE terminating. A verdict already established by stronger evidence
        // must not be replaced by a weaker causal guess just because cleanup killed the
        // process; the classifier's rule order enforces the same thing from the other side.
        await this.#reconcileFromTranscript()
        await this.#pty.terminate()
      } else if (mode === 'abandoned') {
        // We are walking away from the transport, not asserting anything about the turns.
        // Only turns with no verdict yet: abandonment asserts nothing about a turn whose
        // outcome is already established -- walking away does not un-complete it. Routed
        // through the tracker so the verdict it holds matches what the stream reported.
        for (const turn of this.#liveTurns()) {
          this.#apply(turn, turn.tracker.observeObservationGap(), true)
        }
        // Record the gap first, THEN terminate. The distinction between the two modes is
        // epistemic, not custodial: abandonment refuses to claim anything about the turns,
        // and it was never meant to leak the process. It did -- the first live rotation
        // rolled back, closed its replacement as abandoned, and left a Claude CLI running.
        // The node process then could not exit for 26 minutes, which is how this was found.
        //
        // Terminating after the gap is recorded means cleanup cannot manufacture a verdict:
        // the tracker already holds `unknown_abnormal_end`, and process death is weaker
        // evidence than what it holds, so the classifier's rule order discards it.
        if (this.#pty.alive) await this.#pty.terminate()
      }

      this.#stopTailing()
      await this.#receiver.stop()
      this.#state = 'terminated'
    } finally {
      this.#events.close()
    }
  }

  /** Test/diagnostic access. */
  get closeMode(): string | undefined {
    return this.#closeMode
  }
  get inputLog() {
    return this.#input.actions
  }
  get receiver(): HookReceiver {
    return this.#receiver
  }
  get pty(): PtyProcess {
    return this.#pty
  }
}
