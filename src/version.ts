import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What this build actually is, not merely what its package.json claims.
 *
 * `package.json` is bumped once per release, so a checkout running thirteen commits past a
 * tag reported the tag -- and a symlink on PATH pointing into a working tree is the normal
 * way to run this while developing it. Two projects filed bugs against builds it described
 * as `0.2.7`; one of them supplied the commit by hand because the tool would not.
 *
 * A release archive carries no `.git`, so it gets the plain version and nothing is appended.
 * A checkout gets the commit and a `-dirty` marker, which is the difference between "I know
 * exactly what you ran" and a guess.
 *
 * Read rather than compiled in, because there is no build step to compile it in at.
 */
export function version(): string {
  let base = 'unknown'
  try {
    base = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version
  } catch {
    /* an install missing its manifest is broken in a way this line cannot fix */
  }
  try {
    const root = join(import.meta.dirname, '..')
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    // `rev-parse --show-toplevel` rather than `rev-parse HEAD` so a checkout of some OTHER
    // repository that happens to contain this install is not mistaken for conclave's own
    // history. The top-level must also resolve to the same real path as the install root,
    // or a symlinked install inside a different repo would borrow that repo's identity.
    if (git(['rev-parse', '--show-toplevel']) !== realpathSync(root)) return base
    const commit = git(['rev-parse', '--short', 'HEAD'])
    const dirty = git(['status', '--porcelain']) === '' ? '' : '-dirty'
    return `${base} (${commit}${dirty})`
  } catch {
    // No git, or not a checkout: a release archive, which is exactly the case where the
    // package version is the whole truth.
    return base
  }
}
