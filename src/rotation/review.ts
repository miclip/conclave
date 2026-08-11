/**
 * The reviewer's briefing (#72, D9b).
 *
 * §7a's rotation handoff already answers "what does a fresh, blind seat need": not a
 * participant's account of its own work, but a MECHANICAL capture the orchestrator took
 * itself -- `capture()` in `record.ts` builds a `RepoRecord` from the filesystem and git,
 * never from prose. A reviewer needs the same posture for the same reason: "the reviewer
 * reads the diff and the tree, never the producer's summary" is `record.ts`'s whole
 * argument aimed at a second blind seat instead of a replacement one.
 *
 * So this reuses `capture()` outright rather than inventing a second mechanical reader, and
 * adds exactly the one thing rotation never needed -- an actual unified diff, because a
 * replacement reproduces a STATE and a reviewer judges a CHANGE. `buildReviewContext` is the
 * whole of what's added: a diff capture beside `capture()`, and a prompt shaped like
 * `acceptancePrompt()` with the diff in place of the goal.
 *
 * What is NOT here on purpose: the producing seat's own report. Nothing in this module reads
 * one, and nothing it returns has room for one -- a reviewer fed the producer's account of its
 * own work inherits exactly the defect it exists to catch.
 */

import { spawnSync } from 'node:child_process'
import { capture, type CaptureOptions, type RepoRecord } from './record.ts'

export interface ReviewContext {
  /** What changed, as git reports it -- never as the producing seat described it. */
  diff: string
  /** The mechanical half of a rotation handoff, reused verbatim: files, checks, HEAD, dirty. */
  record: RepoRecord
  /** The instruction the producing seat was given. The advisor's words, not the seat's. */
  instruction: string
}

export interface CaptureDiffOptions {
  /** The seat's own tree: its worktree path at N>1, the shared cwd at N=1. */
  root: string
  /**
   * What the diff is taken AGAINST. The integration checkout's HEAD at N>1 -- the same
   * parent `integrateSeat` would merge onto -- or a sha captured at run start at N=1, where
   * there is no separate integration checkout to diff against.
   */
  base: string
}

/**
 * A unified diff of one seat's tree against a base, captured mechanically.
 *
 * `git diff <base>` rather than `git diff <base>..HEAD`: the two-dot form ignores
 * uncommitted changes, and a seat with no worktree (N=1) does its work directly in the
 * shared checkout with nothing forcing it to commit before its turn ends. The one-argument
 * form diffs the base against the current working tree, committed or not, which is what a
 * reviewer needs to see everything the turn actually did.
 */
export function captureDiff(opts: CaptureDiffOptions): string {
  const r = spawnSync('git', ['diff', opts.base], {
    cwd: opts.root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return r.status === 0 ? r.stdout : ''
}

/** The paths the diff above touches, so `capture()` knows what to digest without being told. */
export function changedFiles(opts: CaptureDiffOptions): string[] {
  const r = spawnSync('git', ['diff', '--name-only', opts.base], {
    cwd: opts.root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  return r.status === 0 ? r.stdout.split('\n').filter((l) => l.trim().length > 0) : []
}

export interface BuildReviewContextOptions extends Omit<CaptureOptions, 'files'> {
  base: string
  /** The advisor's instruction to the producing seat. Never that seat's report. */
  instruction: string
}

/**
 * The mechanical half of a review, built the way a rotation handoff's record is: captured
 * by the orchestrator, from the tree, independent of anything a participant said about it.
 *
 * `files` is the diff's own file list rather than something the caller names -- a rotation
 * handoff's file list is the ADVISOR's claim of what matters (`HandoffNarrative.files`), and
 * asking a reviewer's caller for the same thing would reopen the door this module exists to
 * close. The diff already says what changed; nothing needs to assert it a second time.
 */
export function buildReviewContext(opts: BuildReviewContextOptions): ReviewContext {
  const diffOpts = { root: opts.root, base: opts.base }
  return {
    diff: captureDiff(diffOpts),
    record: capture({ ...opts, files: changedFiles(diffOpts) }),
    instruction: opts.instruction,
  }
}

/**
 * What the reviewer is actually sent.
 *
 * Structurally close to `acceptancePrompt()`: a fixed shape, the mechanical facts first,
 * and an exact reply format demanded up front so a reply that cannot be read is treated as
 * no verdict rather than generously interpreted. ACCEPT/REJECT rather than a free verdict,
 * for the reason DONE/ESCALATE are keywords rather than prose the relay parses by guessing.
 */
export function reviewPrompt(ctx: ReviewContext): string {
  const checks =
    ctx.record.checks.length > 0
      ? ctx.record.checks.map((c) => `- \`${c.command}\`: exit ${c.exitCode ?? '(did not run)'}`).join('\n')
      : '- (none configured)'
  const files =
    ctx.record.files.length > 0 ? ctx.record.files.map((f) => `- ${f.path}`).join('\n') : '- (none named)'
  const diff = ctx.diff.trim().length > 0 ? ctx.diff : '(no textual diff -- the tree is unchanged or unreadable)'

  return `You are the REVIEWER. A seat was given this instruction:

${ctx.instruction}

What follows is captured by the orchestrator directly from that seat's tree -- never written
or summarised by the seat itself. Treat it as the only reliable account of what happened;
nothing else here is the seat's claim about its own work.

Files touched:
${files}

Configured checks, run in that seat's own tree:
${checks}

The diff:

\`\`\`diff
${diff}
\`\`\`

Read the diff. Decide whether this should merge.

Reply with exactly ACCEPT and nothing else if it should. Reply with a line starting REJECT:
followed by why, if it should not -- be specific enough that the seat that produced this can
act on it without seeing your reasoning restated. A rejection becomes a task assigned back to
that seat; a second rejection of the same work escalates to the operator.`
}
