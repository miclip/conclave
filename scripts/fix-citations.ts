/**
 * Repair `path:line` citations that moved, in CITED and in the prose together.
 *
 *   npm run citations:fix           # repair
 *   npm run citations:fix -- --check # say what would change, write nothing
 *
 * A citation's TOKEN is what carries the meaning; the line number is a lookup key that rots on
 * every edit above it. `relay.ts` has eighteen citations into it, so a fifteen-line insertion
 * invalidates a block of them at once, mechanically, with nothing to decide.
 *
 * This does the mechanical part and refuses the rest. A token found exactly once has moved and
 * is repaired. A token found nowhere is GONE, and one found several times was never a pin --
 * both are what the guard exists to raise, both need a human to say whether the claim survives,
 * and neither is guessed at. The refusals are printed and the exit code is non-zero, so this
 * cannot be run in a loop until it goes quiet.
 *
 * A citation is not one thing in one place: it is the DECLARATION in `CITED`, the mentions in the
 * prose, and -- since #164 -- the claims in `docs/**` sections marked `## LIVE:`, which the guard
 * checks both ways. So a repair is planned as a PAIR and lands as one, or it is declined by name
 * and neither side of it is touched (#170). Frozen docs sections are never rewritten: they record
 * what was true when they were written, and the guard does not check them.
 *
 * Every proposed move is verified against the file before anything is written, the whole plan is
 * simulated in memory before any of it is, and the tree is re-read after, so a wrong inference
 * fails loudly rather than landing.
 *
 * Nothing is decided here. The planning, the rewriting and the live/frozen rule all live in
 * `src/contract/citations.ts` beside the guard that reads them, because a second copy of a parser
 * is the failure `439cf05` is about.
 */

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  CITED,
  REPO,
  applyRepairs,
  faultsAfterRepair,
  planPairedRepairs,
} from '../src/contract/citations.ts'

/** Where the run's two kinds of line go. `console` satisfies it; a test collects them instead. */
export interface FixerOutput {
  log: (line: string) => void
  error: (line: string) => void
}

/**
 * The whole of the command, minus the two lines that connect it to the process.
 *
 * A function returning an EXIT CODE rather than a script calling `process.exit`, so the contract
 * the operator relies on -- what `--check` writes (nothing), and what each outcome exits with --
 * is provable against a fixture tree instead of asserted about by hand. The alternative, testing
 * the planner and calling that the command, proves the part that was never in doubt: `--check`
 * writes nothing because nothing tells it to, which is exactly the kind of reasoning #170 is
 * about not trusting.
 *
 *   0  nothing to repair, or everything repaired
 *   1  something was refused and still needs a human (with `--check`, would be)
 *   2  a repair was written and did not verify -- the tree has been changed
 */
export function runFixer(
  argv: readonly string[] = process.argv.slice(2),
  out: FixerOutput = console,
  cited: Record<string, string> = CITED,
  root: string = REPO,
): number {
  const check = argv.includes('--check')
  const { repairs, refused, writes, faulted } = planPairedRepairs(cited, root)

  if (repairs.length === 0 && refused.length === 0) {
    out.log('citations: nothing to repair')
    return 0
  }

  for (const r of repairs) out.log(`  ${r.from}  ->  ${r.to}`)
  for (const r of refused) out.log(`  REFUSED ${r.cite}: ${r.why}`)

  if (check) {
    for (const f of [...writes.keys()].sort()) out.log(`  would write ${f}`)
    out.log(
      `\ncitations: ${repairs.length} would be repaired across ${writes.size} files, ${refused.length} refused (nothing written)`,
    )
    return refused.length > 0 ? 1 : 0
  }

  const by = new Map(repairs.map((r) => [r.from, r.to]))
  const touched = applyRepairs(writes, root)

  // Re-verified against what is now on disk. The plan checked each move before proposing it and
  // simulated the whole set before writing any of it; this checks that writing actually took,
  // which is the half a plan cannot prove -- both that a repaired citation now holds, and that no
  // old spelling was left behind in a live docs claim, which is the failure #170 was filed about.
  //
  // Against the REPAIRED spellings, not against the imported table. `CITED` was read into memory
  // before any of this ran, so checking it after writing asks whether the old line numbers hold
  // in the new file -- which they cannot, by construction. The first version of this script did
  // exactly that and reported total failure over a set of repairs that were all correct. The
  // refusals are held apart for the same reason: a refused citation is still faulted afterwards,
  // and reporting that as a repair that failed buries the one line saying which pair needs a
  // human. `untouched` is deliberately not printed: those ARE the REFUSED lines above, and
  // reprinting them through `citationFault` would append its "`npm run citations:fix` repairs
  // this" hint to the very citations this run just declined to repair.
  const { broken, halfRepaired } = faultsAfterRepair(by, faulted, cited, root)

  out.log(`\ncitations: repaired ${repairs.length} across ${touched.length} files`)
  for (const f of touched) out.log(`  ${f}`)

  if (broken.length > 0 || halfRepaired.length > 0) {
    out.error('\ncitations: repairs did not verify \u2014 the tree has been changed, review it:')
    for (const f of broken) out.error(`  ${f}`)
    for (const f of halfRepaired) out.error(`  ${f}`)
    return 2
  }
  if (refused.length > 0) {
    out.error(`\ncitations: ${refused.length} refused above and still need a human`)
    return 1
  }
  return 0
}

/**
 * Run as a command, rather than imported for its `runFixer`.
 *
 * `import.meta.main` says this in one word and arrived in Node 24.2. `engines` says 24.0.0, and a
 * guard that is quietly `undefined` on a version we claim to support turns the whole command into
 * a no-op that exits 0 -- a repair tool that reports success having done nothing, which is the
 * shape of failure this file exists to remove. So it is spelled out against the entry point
 * instead, through `realpathSync` because `import.meta.url` is already symlink-resolved and
 * `process.argv[1]` is not.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url
  } catch {
    return false
  }
}

if (invokedDirectly()) process.exit(runFixer())
