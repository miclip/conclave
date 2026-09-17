/**
 * What a permission request was FOR, when the tool's input says so plainly.
 *
 * The bare notice named the tool and nothing else, and #177 reports that as the one detail
 * that would most have narrowed it: `Bash` is every command a seat runs, so a line naming only
 * `Bash` cannot be matched to anything that happened. The shapes handled here are the ones the
 * adapters actually send; anything else adds nothing and is left off rather than guessed at.
 *
 * Shared by the console's activity line and the relay's routing-log note (#315), so the record
 * and the screen describe one prompt the same way.
 */
export function permissionDetail(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const i = input as { command?: unknown; file_path?: unknown; path?: unknown }
  const what = [i.command, i.file_path, i.path].find((v) => typeof v === 'string' && v.length > 0)
  if (typeof what !== 'string') return ''
  const one = what.replace(/\s+/g, ' ').trim()
  return `: ${one.length > 60 ? `${one.slice(0, 59)}…` : one}`
}
