/**
 * Recognising a hook registration written by an older Conclave.
 *
 * Until #258 both project templates rendered a path INTO the install tree -- Claude's at
 * `<root>/spikes/hooks/hook_post.py`, Codex's at `node <root>/src/hooks/client.ts`. That
 * was stable only while the install was one checkout. Since #250 it is
 * `conclave-releases/v<version>`, a new directory every release, so every registration
 * froze on whichever version happened to be current the day it was written: still firing
 * out of that version's code with nothing saying so, or broken outright once
 * `--prune-install` removed the directory.
 *
 * The replacement names no directory at all, so the two are told apart by exactly this:
 * a command that carries an install path is old. Kept in its own module, with no imports,
 * because both the installer and the Codex trust diagnosis have to answer the question and
 * the diagnosis is upstream of the installer.
 *
 * This is knowledge with an expiry date, and deliberately so. It exists to make an upgrade
 * legible -- "this was written by the Conclave at <path> and is being replaced" -- not to
 * keep those registrations working. Nothing here retains or repairs one.
 */

/**
 * The install root a registration was rendered against, if it was written by a Conclave
 * old enough to bake one in.
 *
 * Both historical spellings, because a project registered before the Codex sidecar moved
 * off the spike's Python client has the first and one registered after has the second --
 * and an operator upgrading today may be carrying either.
 *
 * Absolute paths only (`/`-anchored): a relative command was never something these
 * templates rendered, and matching one would let an unrelated project's own hook be
 * reported as ours.
 */
const LEGACY_COMMAND =
  /"command"\s*:\s*"(?:node\s+)?(\/[^"]*?)\/(?:spikes\/hooks\/hook_post\.py|src\/hooks\/client\.ts)(?=[\s"])/

export function legacyInstallRootOf(registration: string): string | undefined {
  return LEGACY_COMMAND.exec(registration)?.[1]
}
