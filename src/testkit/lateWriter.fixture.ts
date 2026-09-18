/**
 * A child that is still writing into its scratch directory when cleanup reaches the top of
 * it -- the #222 race, staged on purpose. Not named `*.test.ts`, so `npm test` never collects
 * it; `tempDir.test.ts` spawns it with the issued directory as its one argument.
 *
 * The race has to land in a window that is microseconds wide: cleanup's recursive walk has
 * listed the directory and unlinked what it found, and has not yet called `rmdir` on it. A
 * child writing at random would hit that window sometimes, which is a flaky test in both
 * directions. So the child does not guess; it watches the walk.
 *
 * It builds a deep chain of single-entry directories under the scratch directory and waits at
 * the bottom for `leaf` to disappear. A recursive removal is depth-first, so the leaf goes
 * first and the walk then spends its time unwinding: one `rmdir` per level, plus the sibling
 * files at each level that sort after the chain in the filesystem's own iteration order. The
 * chain is deep enough that this unwind is tens of milliseconds on macOS and over ten on
 * Linux, and the child's burst of writes into the TOP directory is about one; the files land
 * while the walk is still on its way up. The top directory's listing was taken before they
 * existed, and both the filesystems CI runs on (APFS, ext4) iterate in hash order with a
 * cursor, so roughly half of them are invisible to the listing in progress. `rmdir` at the top
 * then fails with ENOTEMPTY, and only a retry that walks again can finish the job.
 *
 * The chain directories are named at random so that where the siblings fall relative to the
 * chain is a fresh draw at every level: the unwind's length is then a sum of many small
 * independent amounts rather than one fixed but unknown one.
 *
 * `chdir` rather than a growing absolute path: it keeps the depth out of `PATH_MAX` and makes
 * the poll a one-component lookup, so the child notices the leaf go within microseconds.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

const CHAIN_DEPTH = 300
const SIBLINGS_PER_LEVEL = 2
const LATE_FILES = 16
const GIVE_UP_MS = 5_000

const dir = process.argv[2]
if (!dir) {
  process.stderr.write('usage: lateWriter.fixture.ts <issued scratch directory>\n')
  process.exit(2)
}

const NAMES = 'abcdefghijklmnopqrstuvwxyz0123456789'
process.chdir(dir)
for (let level = 0; level < CHAIN_DEPTH; level++) {
  const name = NAMES[randomBytes(1)[0]! % NAMES.length]!
  mkdirSync(name)
  for (let s = 0; s < SIBLINGS_PER_LEVEL; s++) writeFileSync(`s${s}`, '')
  process.chdir(name)
}
writeFileSync('leaf', '')

// The handshake: the test ends its body, and so triggers cleanup, only once this is out.
process.stdout.write('LISTENING\n')

const startedAt = Date.now()
while (existsSync('leaf')) {
  if (Date.now() - startedAt > GIVE_UP_MS) {
    process.stdout.write('TIMEOUT: the leaf never went, so no walk reached it\n')
    process.exit(3)
  }
}

let written = 0
let stoppedBy = ''
for (let i = 0; i < LATE_FILES; i++) {
  try {
    writeFileSync(join(dir, `late-${i}`), '')
    written++
  } catch (err) {
    // The walk finished first. That is a legitimate way for the race to come out; the test
    // decides what it proves from the count.
    stoppedBy = (err as NodeJS.ErrnoException).code ?? 'unknown'
    break
  }
}
process.stdout.write(`WROTE ${written}${stoppedBy ? ` then ${stoppedBy}` : ''}\n`)
