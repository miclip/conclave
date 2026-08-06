/**
 * Restore the executable bit on node-pty's prebuilt `spawn-helper`.
 *
 * It ships without it on macOS, and without it every pty.spawn() fails with a bare
 * "posix_spawnp failed" that reads like a native build failure and points nowhere near
 * the actual cause.
 *
 * This asserts the package layout it depends on rather than assuming it. A silent
 * success here is worse than a loud failure: the repair would appear to have run, and
 * the first PTY spawn would fail with the same unhelpful error this script exists to
 * prevent. If node-pty reorganises its prebuilds, this must break at install time.
 */

const { chmodSync, existsSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')

const PKG = join(__dirname, '..', 'node_modules', 'node-pty')
const PREBUILDS = join(PKG, 'prebuilds')

function fail(message) {
  console.error(`\n[fix-node-pty] ${message}\n`)
  console.error('This repair guards against a "posix_spawnp failed" error at first spawn.')
  console.error('If node-pty changed its layout, update scripts/fix-node-pty.cjs to match.\n')
  process.exit(1)
}

// Windows uses conpty and has no spawn-helper; nothing to repair.
if (process.platform === 'win32') {
  console.log('[fix-node-pty] win32: no spawn-helper to repair')
  process.exit(0)
}

if (!existsSync(PKG)) {
  // Installing without the dependency tree (--omit, a docs-only checkout) is legitimate.
  // The failure mode this script prevents cannot occur if node-pty is not present.
  console.log('[fix-node-pty] node-pty not installed; nothing to do')
  process.exit(0)
}

if (!existsSync(PREBUILDS)) {
  // A source build puts the addon in build/Release rather than shipping prebuilds. Only
  // darwin depends on a prebuilt spawn-helper, so only darwin can be broken by its absence.
  if (process.platform !== 'darwin') {
    console.log(`[fix-node-pty] no prebuilds directory; node-pty was built from source`)
    process.exit(0)
  }
  fail(`expected prebuilds directory at ${PREBUILDS}, but it does not exist`)
}

const expectedDir = `${process.platform}-${process.arch}`
const expectedHelper = join(PREBUILDS, expectedDir, 'spawn-helper')

const repaired = []
for (const dir of readdirSync(PREBUILDS)) {
  const helper = join(PREBUILDS, dir, 'spawn-helper')
  if (!existsSync(helper)) continue
  chmodSync(helper, 0o755)
  // Verify rather than trust: a chmod that silently no-ops (read-only store, unusual
  // filesystem) would leave exactly the failure this script is meant to prevent.
  const mode = statSync(helper).mode
  if (!(mode & 0o111)) fail(`chmod did not take effect on ${helper} (mode ${mode.toString(8)})`)
  repaired.push(dir)
}

// Likewise: on a platform that builds node-pty from source there are no prebuilt helpers
// to chmod, and that is not a broken install.
if (repaired.length === 0 && process.platform !== 'darwin') {
  console.log(`[fix-node-pty] ${expectedDir}: no spawn-helper needed on this platform`)
  process.exit(0)
}

if (repaired.length === 0) {
  fail(
    `found no spawn-helper under ${PREBUILDS}\n` +
      `  (looked in: ${readdirSync(PREBUILDS).join(', ') || 'nothing'})`,
  )
}

// `spawn-helper` is a macOS-specific binary: node-pty uses it there to work around
// posix_spawn, and forks directly everywhere else. So its absence is only evidence of a
// problem ON DARWIN — demanding one on Linux failed `npm ci` outright the first time this
// ran in CI, on a platform where there was never anything to repair.
//
// The guard is kept where it means something rather than relaxed everywhere.
if (process.platform === 'darwin' && !existsSync(expectedHelper)) {
  fail(
    `no spawn-helper for this platform (${expectedDir}).\n` +
      `  Repaired: ${repaired.join(', ')}\n` +
      `  node-pty will fail to spawn on this machine.`,
  )
}

console.log(`[fix-node-pty] chmod +x spawn-helper for: ${repaired.join(', ')}`)
