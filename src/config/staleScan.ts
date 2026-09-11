/**
 * Which registrations on this machine still name an install path (#275).
 *
 * `config check` answers "is THIS project stale?" for the directory it is run from. After a
 * layout change the operator's question is "which of my projects are stale?", and nothing could
 * answer it -- so every stale registration was found by somebody happening to run the check
 * somewhere new. On one machine that was twelve of them across six project roots, two of them
 * nested inside another project where a root-level check never looks.
 *
 * SEPARATE FROM `legacyRegistration.ts` ON PURPOSE. That module recognises one registration and
 * is deliberately importless, because the installer and the Codex trust diagnosis both need the
 * answer and neither should drag a filesystem dependency in to get it. Recognition is its job;
 * enumeration is this one's.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { legacyInstallRootOf } from './legacyRegistration.ts'

/** One registration that still carries an install path, and the root it points at. */
export interface StaleRegistration {
  /** The file, absolute. */
  path: string
  /** The install directory its command names — what will stop existing. */
  installRoot: string
}

/**
 * Directories never worth descending into.
 *
 * `node_modules` because a dependency's fixtures are not this operator's registrations, and a
 * single one of them can hold more files than the rest of the scan put together. `.git` for the
 * same reason with worse constants.
 */
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', 'target'])

/** The two files a registration is written to. */
const REGISTRATIONS = [
  join('.claude', 'settings.json'),
  join('.codex', 'hooks.json'),
] as const

/**
 * Every stale registration at or below `from`, depth-limited.
 *
 * DEPTH-LIMITED because the honest alternative is unbounded: pointed at a home directory this
 * would walk everything, and an operator who has to wait for that will not run it. Four levels
 * reaches `~/workspace/<project>/<sub>/.claude/settings.json`, which is where the nested ones
 * that started #275 were found.
 */
export function scanStale(from: string, maxDepth = 4): StaleRegistration[] {
  const found: StaleRegistration[] = []
  const walk = (dir: string, depth: number): void => {
    for (const rel of REGISTRATIONS) {
      const p = join(dir, rel)
      if (!existsSync(p)) continue
      let text: string
      try {
        text = readFileSync(p, 'utf8')
      } catch {
        // Unreadable is not stale. A permissions error here is the operator's to see from the
        // filesystem, and reporting it as a stale registration would be a false positive in a
        // list whose whole value is that every entry needs action.
        continue
      }
      const installRoot = legacyInstallRootOf(text)
      if (installRoot !== undefined) found.push({ path: p, installRoot })
    }
    if (depth >= maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.startsWith('.') && name !== '.claude' && name !== '.codex') continue
      if (SKIP.has(name)) continue
      const child = join(dir, name)
      try {
        if (statSync(child).isDirectory()) walk(child, depth + 1)
      } catch {
        // A symlink to nowhere, or something removed mid-walk. Not stale, not an error.
      }
    }
  }
  walk(from, 0)
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

/** What an operator reads. Empty is stated rather than printed as nothing. */
export function formatStale(found: StaleRegistration[], from: string): string {
  if (found.length === 0) {
    return `no registration at or below ${from} names an install path`
  }
  const roots = [...new Set(found.map((f) => f.installRoot))]
  const lines = [
    `${found.length} registration${found.length === 1 ? '' : 's'} still name an install path:`,
    '',
    ...found.map((f) => `  ${f.path}`),
    '',
    `  pointing at: ${roots.join(', ')}`,
    '',
    // The part that decides whether this is urgent, and it is not obvious from the list.
    `These resolve while ${roots.length === 1 ? 'that directory exists' : 'those directories exist'} and stop the moment ${roots.length === 1 ? 'it goes' : 'they go'}.`,
    'Re-run `conclave config install` in each project to move it off the install path.',
  ]
  return lines.join('\n')
}
