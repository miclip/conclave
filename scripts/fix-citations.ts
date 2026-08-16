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
 * Every proposed move is verified against the file before anything is written, and the whole
 * plan is re-verified after, so a wrong inference fails loudly rather than landing.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CITED,
  REPO,
  citationFault,
  planRepairs,
  repairText,
  sourceFiles,
} from '../src/contract/citations.ts'

const check = process.argv.includes('--check')

const { repairs, refused } = planRepairs()

if (repairs.length === 0 && refused.length === 0) {
  console.log('citations: nothing to repair')
  process.exit(0)
}

for (const r of repairs) console.log(`  ${r.from}  ->  ${r.to}`)
for (const r of refused) console.log(`  REFUSED ${r.cite}: ${r.why}`)

if (check) {
  console.log(
    `\ncitations: ${repairs.length} would be repaired, ${refused.length} refused (nothing written)`,
  )
  process.exit(refused.length > 0 ? 1 : 0)
}

const by = new Map(repairs.map((r) => [r.from, r.to]))

// The registry first. It is not in `sourceFiles()` -- it is excluded from scanning precisely
// because it carries citations as data -- so a pass over the sources alone would repair the
// prose and leave every declaration pointing at the old line.
const files = ['src/contract/citations.ts', ...sourceFiles()]
const touched: string[] = []
for (const file of files) {
  const path = join(REPO, file)
  const before = readFileSync(path, 'utf8')
  const after = repairText(before, by)
  if (after === before) continue
  if (!check) writeFileSync(path, after)
  touched.push(file)
}

// Re-verified against what is now on disk. `planRepairs` checked each move before proposing it;
// this checks that writing them actually took, which is the half a plan cannot prove -- a
// citation the rewriter failed to find would leave CITED repaired and the prose stale, and the
// two drifting apart is the exact thing this table exists to prevent.
//
// Against the REPAIRED spellings, not against the imported table. `CITED` was read into memory
// before any of this ran, so checking it after writing asks whether the old line numbers hold in
// the new file -- which they cannot, by construction. The first version of this script did
// exactly that and reported total failure over a set of repairs that were all correct.
const stillWrong = Object.entries(CITED)
  .map(([cite, expected]) => citationFault(by.get(cite) ?? cite, expected))
  .filter((f) => f !== undefined)

console.log(`\ncitations: repaired ${repairs.length} across ${touched.length} files`)
for (const f of touched) console.log(`  ${f}`)

if (stillWrong.length > 0) {
  console.error('\ncitations: repairs did not verify — the tree has been changed, review it:')
  for (const f of stillWrong) console.error(`  ${f}`)
  process.exit(2)
}
if (refused.length > 0) {
  console.error(`\ncitations: ${refused.length} refused above and still need a human`)
  process.exit(1)
}
