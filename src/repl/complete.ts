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

export interface Completion {
  line: string
  cursor: number
  /** More than one candidate: the caller may want to show them. */
  candidates?: string[]
}

const PARTICIPANTS = ['advisor', 'implementer']

function longestCommonPrefix(items: string[]): string {
  if (items.length === 0) return ''
  let prefix = items[0]!
  for (const item of items) {
    while (!item.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  return prefix
}

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

export function complete(line: string, cursor: number, cwd: string): Completion | undefined {
  const upto = line.slice(0, cursor)
  // Addressing only leads the line, because it is a property of the whole message. A path
  // is a reference inside prose and may be anywhere.
  const to = /^>([^\s]*)$/.exec(upto)
  const at = /(^|\s)@([^\s]*)$/.exec(upto)
  const partial = to ? (to[1] ?? '') : (at?.[2] ?? '')
  if (!to && !at) return undefined

  const start = cursor - partial.length
  const candidates = to
    ? PARTICIPANTS.filter((p) => p.startsWith(partial))
    : pathCandidates(cwd, partial)
  if (candidates.length === 0) return undefined

  // One match completes; several complete as far as they agree, which is what makes
  // repeated tabs converge rather than cycle.
  // A single match is finished with a space — except a directory, where the next tab is
  // meant to descend into it and a space would end the token instead.
  const only = candidates.length === 1 ? candidates[0]! : undefined
  const completed = only ? (only.endsWith('/') ? only : `${only} `) : longestCommonPrefix(candidates)
  if (completed === partial && candidates.length > 1) {
    return { line, cursor, candidates }
  }
  const next = line.slice(0, start) + completed + line.slice(cursor)
  return {
    line: next,
    cursor: start + completed.length,
    ...(candidates.length > 1 ? { candidates } : {}),
  }
}
