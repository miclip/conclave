/**
 * Tab completion for the input line.
 *
 * Two sigils, one meaning each:
 *
 *   >advisor do X          ADDRESS the message to one participant
 *   look at @src/relay/    a PATH, completed from the working directory
 *
 * `@` used to do both, disambiguated by position — addressing only as the first token.
 * That rule existed solely to carry the overload, and `>` removes the need for it: `@`
 * now means exactly what it means in Claude Code and in Codex, which is where the habit
 * comes from and where a pasted path will be understood when it is forwarded.
 *
 * `>` reads as redirection, which is what addressing is, and it echoes the prompt glyph.
 *
 * Paths are NOT inlined. Both participants share the working directory and can open a file
 * themselves, so pasting its contents would spend context on something they can already
 * read — and would silently go stale the moment either of them edited it.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The candidates for whatever is being typed, and the span they would replace.
 *
 * A menu needs the options BEFORE anything is chosen. An earlier tab-only completer forced
 * the guess to be made blind; showing candidates as they narrow lets the choice be made by
 * looking, which is how both Claude Code and Codex do it.
 */
export interface Suggestion {
  items: string[]
  /** Character range in the line that accepting an item replaces. */
  start: number
  end: number
  /** Appended after the item unless it already ends with a separator. */
  suffix: string
}

export function suggest(
  line: string,
  cursor: number,
  cwd: string,
  commands: string[] = [],
): Suggestion | undefined {
  const upto = line.slice(0, cursor)

  // A slash command, but only as the first token: `/help` leads a line, and a slash inside
  // prose is a slash.
  const slash = /^\/([^\s]*)$/.exec(upto)
  if (slash) {
    const partial = `/${slash[1] ?? ''}`
    const items = commands.filter((c) => c.startsWith(partial))
    return items.length > 0 ? { items, start: 0, end: cursor, suffix: ' ' } : undefined
  }

  const to = /^>([^\s]*)$/.exec(upto)
  if (to) {
    const partial = to[1] ?? ''
    const items = PARTICIPANTS.filter((p) => p.startsWith(partial)).map((p) => `>${p}`)
    return items.length > 0 ? { items, start: 0, end: cursor, suffix: ' ' } : undefined
  }

  const at = /(^|\s)@([^\s]*)$/.exec(upto)
  if (at) {
    const partial = at[2] ?? ''
    const items = pathCandidates(cwd, partial).map((p) => `@${p}`)
    // No suffix on a directory: the next keystroke should descend into it.
    return items.length > 0
      ? { items, start: cursor - partial.length - 1, end: cursor, suffix: '' }
      : undefined
  }
  return undefined
}

/**
 * `both` is an alias for typing nothing at all, and exists only so the menu can say so.
 *
 * The default — plain text reaches both participants — is the one piece of the addressing
 * model that is invisible: you learn it by not doing something. Listing it beside the two
 * narrowing options makes the whole choice legible at the moment it is being made.
 */
const PARTICIPANTS = ['advisor', 'implementer', 'both']

/** Directory entries matching a partial path, with `/` appended to directories. */
function pathCandidates(cwd: string, partial: string): string[] {
  const dir = partial.endsWith('/') ? partial : dirname(partial)
  const base = partial.endsWith('/') ? '' : partial.slice(dir === '.' ? 0 : dir.length + 1)
  const abs = join(cwd, dir === '.' ? '' : dir)
  if (!existsSync(abs)) return []
  let names: string[]
  try {
    names = readdirSync(abs)
  } catch {
    return []
  }
  return names
    .filter((n) => n.startsWith(base))
    // Dotfiles only when explicitly asked for, or `@` offers `.git` before anything useful.
    .filter((n) => base.startsWith('.') || !n.startsWith('.'))
    .map((n) => {
      const rel = dir === '.' ? n : `${dir.replace(/\/$/, '')}/${n}`
      return statSync(join(cwd, rel)).isDirectory() ? `${rel}/` : rel
    })
    .sort()
}

