/**
 * A capability an agent can be TOLD to use is a claim with a source and an expiry date, and
 * these guards are what keep it from decaying into a boolean.
 *
 * Nothing renders this data yet. That is precisely why it is pinned now: an undeclared field is
 * meant to mean "nobody said" and a declared one is meant to carry where it came from, and both
 * properties are trivial to lose in the edit that first needs them for a briefing.
 *
 *   node --test src/registry/instructionCapabilities.test.ts
 */

import { strict as assert } from 'node:assert'
import childProcess, { execFileSync } from 'node:child_process'
import dns from 'node:dns'
import { mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../testkit/tempDir.ts'
import { defaultRegistry } from './builtin.ts'
import { findExecutable } from './executables.ts'
import {
  CLAUDE_INSTRUCTION_CAPABILITIES,
  CODEX_INSTRUCTION_CAPABILITIES,
  KIMI_INSTRUCTION_CAPABILITIES,
  OPENCODE_INSTRUCTION_CAPABILITIES,
} from './instructionCapabilities.ts'
import { ABSENT_LITERAL_CANARY, installedBundle } from './installedBundle.ts'
import { NO_DEADLINE_CLOCKS, type GradedClaim, type InstructionCapabilities } from './types.ts'

const DECLARED: ReadonlyArray<readonly [string, InstructionCapabilities]> = [
  ['claude', CLAUDE_INSTRUCTION_CAPABILITIES],
  ['codex', CODEX_INSTRUCTION_CAPABILITIES],
  ['opencode', OPENCODE_INSTRUCTION_CAPABILITIES],
  ['kimi', KIMI_INSTRUCTION_CAPABILITIES],
]

/** Every declared claim, flattened, so a guard cannot silently iterate nothing. */
function claims(): Array<{ agent: string; capability: string; claim: GradedClaim }> {
  const out: Array<{ agent: string; capability: string; claim: GradedClaim }> = []
  for (const [agent, caps] of DECLARED) {
    for (const [capability, claim] of Object.entries(caps)) {
      if (claim) out.push({ agent, capability, claim })
    }
  }
  assert.ok(out.length >= 14, 'the guards below are worthless over an empty list')
  return out
}

test('a definition that declares nothing claims nothing: no default is invented', () => {
  // The asymmetry with `deadlines` in one assertion. A missing `deadlines` had to be refused
  // because its absence would report as a deadline the adapter does not run; silence HERE
  // removes a claim instead. If the registry defaulted this to `{}`, "nobody said" and "asked
  // and told no" would become the same answer, which is the distinction the field exists for.
  const r = defaultRegistry().register({
    id: 'future-agent',
    displayName: 'Not built yet',
    capabilities: { ...defaultRegistry().get('codex').capabilities, agent: 'future-agent' },
    deadlines: NO_DEADLINE_CLOCKS,
    launch: { command: 'future', baseArgs: [] },
    unavailableReason: 'adapter not written',
  })
  assert.equal(r.get('future-agent').instructionCapabilities, undefined)
})

test('every built-in wires its declaration, and declares exactly what §4b resolved', () => {
  // Read through the registry rather than off the constants, so this pins the WIRING too. An
  // absent capability is UNRESOLVED -- not advertised in any source searched -- and that is a
  // statement about our searching, not about the CLI. `turnBoundedLifetime` is absent from all
  // four: every one of them advertises starting background work, none advertises when it ends.
  const expected: Record<string, string[]> = {
    claude: ['autonomousLoop', 'backgroundTasks', 'sessionBackgrounding', 'subagents'],
    codex: ['backgroundTasks', 'subagents'],
    opencode: ['asyncPromptSubmission', 'backgroundTasks', 'boundedIteration', 'subagents'],
    kimi: ['autonomousLoop', 'backgroundTasks', 'boundedIteration', 'subagents'],
  }
  const r = defaultRegistry()
  for (const [agent, keys] of Object.entries(expected)) {
    const declared = r.get(agent).instructionCapabilities
    assert.ok(declared, `${agent} must carry its declaration`)
    assert.deepEqual(Object.keys(declared).sort(), keys, `${agent} declares exactly §4b`)
  }
})

test('no claim is graded observed: an advertisement is not a behaviour', () => {
  // The masquerade `EVIDENCE_LEVELS` exists to prevent. `observed` requires a real run against
  // the installed version with a fixture captured; not one of these was performed. Promoting a
  // `--help` string to `observed` is the single most damaging edit possible to this file.
  for (const { agent, capability, claim } of claims()) {
    assert.equal(
      claim.evidence,
      'inferred_from_documented_event',
      `${agent}.${capability} is derived from what the binary declares, nothing more`,
    )
  }
})

test('every claim names a source and pins the version it was read from', () => {
  for (const { agent, capability, claim } of claims()) {
    assert.ok(claim.source.trim().length > 0, `${agent}.${capability} must say where it came from`)
    assert.ok(
      claim.sourceVersion.trim().length > 0,
      `${agent}.${capability} must pin what it was read from`,
    )
  }
})

test('each agent pins ONE version literal, so "is this stale" has a single answer', () => {
  // Consistency WITHIN an agent, which is all this can honestly check. Two claims for the same
  // CLI read from different versions would make staleness unanswerable for the agent as a whole.
  //
  // What this deliberately no longer does is compare the pin against a hardcoded copy of itself
  // (#201). That assertion passed while the Claude pin drifted eight versions behind the
  // installed CLI, because both sides of it said the same thing -- a claim about another program
  // checked against a restatement of itself, which is the failure `hookEventNames.test.ts` was
  // written to prevent. Whether a claim is still TRUE is answered by the probe search below;
  // this only answers whether the file disagrees with itself.
  const seen = new Map<string, string>()
  for (const { agent, capability, claim } of claims()) {
    const first = seen.get(agent)
    if (first === undefined) seen.set(agent, claim.sourceVersion)
    else assert.equal(claim.sourceVersion, first, `${agent}.${capability} pins a different version from its siblings`)
  }
  assert.ok(seen.size > 0, 'the walk must find claims, or this asserts nothing')
})

/** Which program a command name stands for: what a pin is a pin OF. */
type ProgramIdentity = { command: string; ecosystem: 'python' | 'npm'; package: string }

/**
 * The program every Kimi claim in this file was read from: `kimi`, as shipped by the PyPI
 * package `kimi-cli`.
 *
 * Recorded because the command name stopped identifying it. `kimi-cli` is archived, and its
 * successor, npm `@moonshot-ai/kimi-code`, installs a `kimi` too -- a different program with a
 * different surface (spikes/kimi/KIMI-CODE-2.3.2.md). `KIMI_VERSION` alone cannot tell them
 * apart; it pins a version without saying of what.
 *
 * A mismatch is a NOTICE, not a failure, on the same tradeoff as `noteVendorVersion` in
 * `evenCompat.test.ts`. To fail, the record would have to name whatever is installed on the
 * machine the suite must pass on, so it would stop saying what the claims were verified
 * against, and it would be red for the operator who upgraded. Failing on the verified record
 * instead fails every machine with the successor installed, a suite that is required green.
 * So the record names what was verified, and a machine running something else is told, once
 * and by name, that its greens are evidence about THAT program. The notice opens #201 rather
 * than having a test of its own on the live machine, so #201 keeps its purpose. It is also
 * emitted before #201's first assertion, so a failing probe does not swallow it.
 */
const KIMI_VERIFIED_IDENTITY: ProgramIdentity = { command: 'kimi', ecosystem: 'python', package: 'kimi-cli' }

/**
 * `version` is what the same install metadata says about itself (#401), read by the same lookup
 * that found the package, so the version always belongs to the identity reported beside it.
 */
type DetectedIdentity = (ProgramIdentity & { evidence: string; version?: string }) | { why: string }

function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** PEP 503: `Kimi_CLI`, `kimi.cli` and `kimi-cli` name one distribution. */
function normalizePython(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

/**
 * An npm package that ships `real` as its `command` bin.
 *
 * The bin mapping has to resolve to the file itself. Any `package.json` above it is not enough,
 * because a Python venv inside a Node project would otherwise be reported as that project.
 */
function npmIdentity(command: string, real: string): DetectedIdentity | undefined {
  let dir = dirname(real)
  for (let up = 0; up < 6; up++) {
    const raw = readOrUndefined(join(dir, 'package.json'))
    if (raw !== undefined) {
      let pkg: { name?: unknown; bin?: unknown; version?: unknown }
      try {
        pkg = JSON.parse(raw) as { name?: unknown; bin?: unknown; version?: unknown }
      } catch {
        return undefined
      }
      if (typeof pkg.name !== 'string') return undefined
      const bin =
        typeof pkg.bin === 'string'
          ? { [pkg.name.split('/').pop()!]: pkg.bin }
          : ((pkg.bin ?? {}) as Record<string, unknown>)
      const target = bin[command]
      if (typeof target !== 'string' || resolve(dir, target) !== real) return undefined
      return {
        command,
        ecosystem: 'npm',
        package: pkg.name,
        evidence: `${join(dir, 'package.json')} bin.${command}`,
        ...(typeof pkg.version === 'string' ? { version: pkg.version } : {}),
      }
    }
    dir = dirname(dir)
  }
  return undefined
}

/**
 * A Python console script: its shebang names the environment's interpreter, and the
 * distribution that declares `command` in `[console_scripts]` is the one that installed it.
 * Covers uv, pipx and pip alike, since all three write the same `.dist-info`.
 */
function pythonIdentity(command: string, real: string): DetectedIdentity | undefined {
  const first = readOrUndefined(real)?.split('\n', 1)[0] ?? ''
  const interpreter = /^#!\s*(\S*\/bin\/python[\d.]*)\s*$/.exec(first)?.[1]
  if (!interpreter) return undefined
  // Not realpath'd: a venv's `bin/python` is a link into wherever the base interpreter lives,
  // and the environment is where the link sits.
  const env = dirname(dirname(interpreter))
  const libs = [
    ...(readdirSafe(join(env, 'lib')).filter((d) => d.startsWith('python')).map((d) => join(env, 'lib', d, 'site-packages'))),
    join(env, 'Lib', 'site-packages'),
  ]
  for (const site of libs) {
    // Sorted, so the order is the same on every filesystem (readdir order is not), and the
    // console-script test below is what picks the distribution, never which entry came first.
    for (const info of readdirSafe(site).filter((d) => d.endsWith('.dist-info')).sort()) {
      const entry = readOrUndefined(join(site, info, 'entry_points.txt'))
      if (!entry || !consoleScripts(entry).includes(command)) continue
      const metadata = readOrUndefined(join(site, info, 'METADATA')) ?? ''
      const name = /^Name:\s*(.+?)\s*$/m.exec(metadata)?.[1]
      if (!name) return { why: `${join(site, info)} declares ${command} but its METADATA names no distribution` }
      const version = /^Version:\s*(.+?)\s*$/m.exec(metadata)?.[1]
      return {
        command,
        ecosystem: 'python',
        package: name,
        evidence: `${join(site, info)} [console_scripts] ${command}`,
        ...(version ? { version } : {}),
      }
    }
  }
  return { why: `${real} runs ${interpreter}, but no .dist-info under ${env} declares ${command}` }
}

/** The script names an `entry_points.txt` declares under `[console_scripts]`. */
function consoleScripts(entryPoints: string): string[] {
  const names: string[] = []
  let inSection = false
  for (const line of entryPoints.split('\n')) {
    const header = /^\s*\[(.+)\]\s*$/.exec(line)
    if (header) inSection = header[1] === 'console_scripts'
    else if (inSection && line.includes('=')) names.push(line.slice(0, line.indexOf('=')).trim())
  }
  return names
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * What program `executable` is, read off the install tree it sits in.
 *
 * Offline by construction: synchronous filesystem reads only. Nothing asks a registry or runs
 * the program, so the answer is what is installed here, which is what every green is about.
 */
function detectIdentity(command: string, executable: string): DetectedIdentity {
  let real: string
  try {
    real = realpathSync(executable)
  } catch (e) {
    return { why: `${executable} could not be resolved: ${String(e)}` }
  }
  return (
    npmIdentity(command, real) ??
    pythonIdentity(command, real) ?? { why: `${real} is neither an npm bin nor a Python console script` }
  )
}

function sameIdentity(a: ProgramIdentity, b: ProgramIdentity): boolean {
  if (a.command !== b.command || a.ecosystem !== b.ecosystem) return false
  return a.ecosystem === 'python' ? normalizePython(a.package) === normalizePython(b.package) : a.package === b.package
}

function named(id: ProgramIdentity): string {
  return `\`${id.command}\` from ${id.ecosystem === 'python' ? 'PyPI' : 'npm'} ${id.package}`
}

/** One line naming the installed program against the recorded one. Never a verdict. */
function identityNotice(recorded: ProgramIdentity, detected: DetectedIdentity): string {
  if ('why' in detected) {
    return `kimi identity: not detected (${detected.why}); the claims were recorded against ${named(recorded)}`
  }
  if (sameIdentity(recorded, detected)) {
    return `kimi identity: checked against ${named(detected)}, the recorded identity (${detected.evidence})`
  }
  return (
    `KIMI IDENTITY DRIFT: the installed ${named(detected)} (${detected.evidence}) is not the recorded ` +
    `${named(recorded)}. Every green in this file about kimi is evidence about ${detected.package}, not ` +
    `${recorded.package}. Re-derive the kimi claims against it, or put ${recorded.package} back on PATH.`
  )
}

function noteKimiIdentity(t: TestContext): void {
  const on = findExecutable(KIMI_VERIFIED_IDENTITY.command, { cwd: process.cwd() })
  const detected = on ? detectIdentity(KIMI_VERIFIED_IDENTITY.command, on) : { why: 'kimi is not on PATH' }
  t.diagnostic(identityNotice(KIMI_VERIFIED_IDENTITY, detected))
}

/* ------------------------------------------------- which version is installed (#401) ------ */

/**
 * What version of `agent` is installed, against the one its claims were read from (#401).
 *
 * A NOTICE, never a failure, for #201's own reason: failing on drift would fail the suite for
 * everyone whose CLI updated overnight, on a day when nothing is wrong. What it adds is the
 * sentence #201 cannot say on its own -- that a green probe search is evidence about the version
 * installed HERE, which may not be the version the claims were read from.
 *
 * Read off the install tree, never by running `--version`: the npm and Python answers come from
 * `npmIdentity` and `pythonIdentity`, the lookup #387 already trusts, because the version that
 * matters is the one belonging to the distribution that declares the command. (The first
 * `.dist-info` in a venv is a confident wrong answer: kimi's has 126.) Claude's native installer
 * names its versions directory after the version, so there the resolved path IS the answer.
 */
type DetectedVersion = { version: string; evidence: string } | { why: string }

/** The version number inside a verbatim `--version` literal: `2.1.260 (Claude Code)` -> `2.1.260`. */
function versionIn(literal: string): string | undefined {
  return /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(literal)?.[0]
}

/** `.../versions/<version>`, the native installer's layout. Any other path carries no version. */
function claudePathVersion(real: string): DetectedVersion {
  const name = real.split(/[\\/]/).pop() ?? ''
  const parent = dirname(real).split(/[\\/]/).pop()
  const version = versionIn(name)
  if (parent !== 'versions' || version !== name) {
    return { why: `${real} is not a versions/<version> path, so it names no version` }
  }
  return { version, evidence: real }
}

function detectVersion(command: string, executable: string): DetectedVersion {
  let real: string
  try {
    real = realpathSync(executable)
  } catch (e) {
    return { why: `${executable} could not be resolved: ${String(e)}` }
  }
  if (command === 'claude') return claudePathVersion(real)
  const id = npmIdentity(command, real) ?? pythonIdentity(command, real)
  if (!id) return { why: `${real} is neither an npm bin nor a Python console script` }
  if ('why' in id) return id
  if (id.version === undefined) return { why: `${id.evidence} names ${id.package} but no version` }
  return { version: id.version, evidence: `${id.ecosystem === 'python' ? 'PyPI' : 'npm'} ${id.package}, ${id.evidence}` }
}

/** One line naming the installed version against the recorded one. Never a verdict. */
function versionNotice(agent: string, recorded: string, detected: DetectedVersion): string {
  if ('why' in detected) {
    return `${agent} version: not detected (${detected.why}); the claims were read from ${JSON.stringify(recorded)}`
  }
  const pinned = versionIn(recorded)
  if (pinned === detected.version) {
    return `${agent} version: checked against installed ${detected.version} (${detected.evidence}), the recorded ${JSON.stringify(recorded)}`
  }
  const was = pinned ?? JSON.stringify(recorded)
  return (
    `${agent.toUpperCase()} VERSION DRIFT: installed ${agent} is ${detected.version} (${detected.evidence}); its claims ` +
    `were read from ${JSON.stringify(recorded)}. Every green in this file about ${agent} is evidence about ` +
    `${detected.version}, not ${was}. Re-derive the ${agent} claims against ${detected.version} and update its sourceVersion.`
  )
}

/** Each agent's one `sourceVersion`; "each agent pins ONE version literal" holds the uniqueness. */
function recordedVersions(): Map<string, string> {
  const out = new Map<string, string>()
  for (const { agent, claim } of claims()) if (!out.has(agent)) out.set(agent, claim.sourceVersion)
  return out
}

/** The notice for `agent` given what PATH resolved it to, if anything. */
function sourceVersionNotice(agent: string, recorded: string, on: string | undefined): string {
  const detected = on ? detectVersion(agent, on) : { why: `\`${agent}\` is not on PATH, so no install was examined` }
  return versionNotice(agent, recorded, detected)
}

function noteSourceVersions(t: TestContext): void {
  for (const [agent, recorded] of recordedVersions()) {
    t.diagnostic(sourceVersionNotice(agent, recorded, findExecutable(agent, { cwd: process.cwd() })))
  }
}

test('#201 every claim can still be re-derived from the installed bundle', (t) => {
  // First, so first: which kimi the rest of this run is evidence about.
  noteKimiIdentity(t)
  // And which version of each agent (#401), before any assertion can swallow it.
  noteSourceVersions(t)

  // THE CHECK THAT WAS MISSING. `sourceVersion` was the staleness rule and nothing enforced it,
  // so four Claude claims sat unverified for eight releases while a briefing was built on one of
  // them (`autonomousLoop`, #192). A stale claim there is a promise nobody re-checked.
  //
  // Version-agnostic on purpose. Every contributor's install moves independently of this repo --
  // Claude Code went 2.1.252 to 2.1.260 while this file sat still -- so failing on drift would
  // fail the suite for everyone whose CLI updated overnight, on a day when nothing was wrong.
  // What matters is whether the literal is STILL THERE, and that question does not need the
  // version to answer it.
  let checked = 0
  for (const { agent, capability, claim } of claims()) {
    const probes = claim.probes
    if (!probes || probes.length === 0) continue
    const found = installedBundle(agent)
    if ('why' in found) {
      t.diagnostic(`${agent}: skipped -- ${found.why}`)
      continue
    }
    assert.equal(
      found.bytes.includes(ABSENT_LITERAL_CANARY),
      false,
      `${agent}: the canary was found, so the search matches anything and the assertions below are vacuous`,
    )
    for (const probe of probes) {
      assert.ok(
        found.bytes.includes(probe),
        `${agent}.${capability}: ${JSON.stringify(probe)} is no longer in the installed bundle (${found.at}). ` +
          `The claim was read at ${claim.sourceVersion} and is now WRONG rather than merely old -- re-derive it or withdraw it.`,
      )
      checked += 1
    }
  }
  t.diagnostic(`${checked} probe(s) re-derived`)
})

test('#201 a claim that is graded on evidence carries something to re-derive it from', () => {
  // The hole this would otherwise leave: probes are optional on the type, because a claim about
  // an agent with no searchable bundle cannot have them. So "the search passed" could also mean
  // "nothing was searched". Every claim that names a bundle as its source must carry probes, or
  // the guard above is opt-in and the next claim added quietly opts out.
  for (const { agent, capability, claim } of claims()) {
    if (claim.evidence === 'unsupported') continue
    if (!/installed (bundle|binary)/.test(claim.source)) continue
    assert.ok(
      claim.probes && claim.probes.length > 0,
      `${agent}.${capability} cites the installed bundle as its source but carries no probe, so nothing can re-derive it`,
    )
  }
})

test('a gap is spelled by absence, never by a declared false', () => {
  // Nothing searched establishes that any of these four CANNOT do one of these things -- an
  // absent literal proves a capability is not advertised, not that it is missing. A
  // `supported: false` would assert a gap nobody verified, which is the same overclaim as an
  // ungrounded true pointing the other way.
  for (const { agent, capability, claim } of claims()) {
    assert.equal(claim.supported, true, `${agent}.${capability} claims only what was found`)
  }
})

/* ------------------------------------------------------- which kimi is installed ---------- */

/** `uv tool install kimi-cli`, laid out as uv lays it out: a `~/.local/bin` link into the tool's venv. */
function uvKimiCli(root: string): string {
  const env = join(root, 'uv', 'tools', 'kimi-cli')
  const info = join(env, 'lib', 'python3.13', 'site-packages', 'kimi_cli-1.49.0.dist-info')
  mkdirSync(join(env, 'bin'), { recursive: true })
  mkdirSync(info, { recursive: true })
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(env, 'bin', 'python'), '')
  writeFileSync(join(env, 'bin', 'kimi'), `#!${join(env, 'bin', 'python')}\nfrom kimi_cli.__main__ import main\n`)
  writeFileSync(join(env, 'uv-receipt.toml'), '[tool]\nrequirements = [{ name = "kimi-cli" }]\n')
  writeFileSync(
    join(info, 'entry_points.txt'),
    '[console_scripts]\nkimi = kimi_cli.__main__:main\nkimi-cli = kimi_cli.__main__:main\n',
  )
  writeFileSync(join(info, 'METADATA'), 'Metadata-Version: 2.4\nName: kimi-cli\nVersion: 1.49.0\n')
  symlinkSync(join(env, 'bin', 'kimi'), join(root, 'bin', 'kimi'))
  return join(root, 'bin', 'kimi')
}

/** `npm install -g @moonshot-ai/kimi-code`: the global bin links straight to the package's `bin.kimi`. */
function npmKimiCode(root: string): string {
  const pkg = join(root, 'lib', 'node_modules', '@moonshot-ai', 'kimi-code')
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  mkdirSync(join(root, 'bin'))
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@moonshot-ai/kimi-code', version: '2.3.2', bin: { kimi: 'dist/main.mjs' } }),
  )
  writeFileSync(join(pkg, 'dist', 'main.mjs'), '#!/usr/bin/env node\n')
  symlinkSync(join(pkg, 'dist', 'main.mjs'), join(root, 'bin', 'kimi'))
  return join(root, 'bin', 'kimi')
}

/**
 * Run `fn` with every way out of the process trapped: sockets (which `fetch`, `http` and
 * `https` all reach), name lookups, and child processes, so no `npm view` or `pip show` either.
 * Detection is synchronous filesystem reads; this is what holds it to that.
 */
function offline<T>(fn: () => T): { result: T; attempts: string[] } {
  const attempts: string[] = []
  const trap = (what: string) => () => {
    attempts.push(what)
    throw new Error(`offline: ${what} attempted`)
  }
  const saved = {
    connect: net.Socket.prototype.connect,
    lookup: dns.lookup,
    fetch: globalThis.fetch,
    cp: { ...childProcess },
  }
  net.Socket.prototype.connect = trap('net.Socket.connect') as never
  dns.lookup = trap('dns.lookup') as never
  globalThis.fetch = trap('fetch') as never
  for (const k of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'] as const) {
    ;(childProcess as Record<string, unknown>)[k] = trap(`child_process.${k}`)
  }
  syncBuiltinESMExports()
  try {
    return { result: fn(), attempts }
  } finally {
    net.Socket.prototype.connect = saved.connect
    dns.lookup = saved.lookup
    globalThis.fetch = saved.fetch
    Object.assign(childProcess, saved.cp)
    syncBuiltinESMExports()
  }
}

test('the archived kimi-cli, installed by uv, is detected as the recorded identity', (t) => {
  const kimi = uvKimiCli(tempDir(t, 'kimi-identity'))
  const { result: detected, attempts } = offline(() => detectIdentity('kimi', kimi))
  assert.deepEqual(attempts, [], 'detection must not leave the machine')
  assert.ok(!('why' in detected), `expected an identity, got: ${'why' in detected ? detected.why : ''}`)
  assert.deepEqual(
    { command: detected.command, ecosystem: detected.ecosystem, package: detected.package },
    KIMI_VERIFIED_IDENTITY,
  )
  const notice = identityNotice(KIMI_VERIFIED_IDENTITY, detected)
  assert.match(notice, /^kimi identity: checked against `kimi` from PyPI kimi-cli, the recorded identity/)
  assert.ok(!/DRIFT/.test(notice), 'the matching identity reports a match and nothing else')
})

test('its npm successor, installing the same `kimi`, is reported as drift and never fails', (t) => {
  const kimi = npmKimiCode(tempDir(t, 'kimi-identity'))
  const { result: detected, attempts } = offline(() => detectIdentity('kimi', kimi))
  assert.deepEqual(attempts, [], 'detection must not leave the machine')
  assert.ok(!('why' in detected), `expected an identity, got: ${'why' in detected ? detected.why : ''}`)
  assert.equal(detected.ecosystem, 'npm')
  assert.equal(detected.package, '@moonshot-ai/kimi-code')
  const notice = identityNotice(KIMI_VERIFIED_IDENTITY, detected)
  assert.match(notice, /^KIMI IDENTITY DRIFT: the installed `kimi` from npm @moonshot-ai\/kimi-code/)
  assert.match(notice, /Every green in this file about kimi is evidence about @moonshot-ai\/kimi-code, not kimi-cli/)
})

/** An npm package that calls itself `kimi-cli` too: same name, different ecosystem. */
function npmNamedLikeThePythonOne(root: string): string {
  const pkg = join(root, 'lib', 'node_modules', 'kimi-cli')
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'kimi-cli', version: '9.0.0', bin: { kimi: 'dist/cli.js' } }))
  writeFileSync(join(pkg, 'dist', 'cli.js'), '#!/usr/bin/env node\n')
  symlinkSync(join(pkg, 'dist', 'cli.js'), join(root, 'bin', 'kimi'))
  return join(root, 'bin', 'kimi')
}

test('a package with the SAME name from a different ecosystem is drift, not a match', (t) => {
  // The ecosystem half of `sameIdentity` carries this alone. Against the npm successor both
  // halves differ, so either one catches it and neither is proved -- a mutation removing the
  // ecosystem check survived that fixture. `kimi-cli` on npm is not `kimi-cli` on PyPI, and
  // nothing but the ecosystem says so.
  const kimi = npmNamedLikeThePythonOne(tempDir(t, 'kimi-identity'))
  const { result: detected, attempts } = offline(() => detectIdentity('kimi', kimi))
  assert.deepEqual(attempts, [], 'detection must not leave the machine')
  assert.ok(!('why' in detected), `expected an identity, got: ${'why' in detected ? detected.why : ''}`)
  assert.equal(detected.ecosystem, 'npm')
  assert.equal(detected.package, 'kimi-cli')
  assert.match(identityNotice(KIMI_VERIFIED_IDENTITY, detected), /^KIMI IDENTITY DRIFT: the installed `kimi` from npm kimi-cli/)
})

test('a layout it cannot identify says so, with where it looked, and never claims a match', (t) => {
  // The third answer, and the one the other two cannot reach: a `kimi` that is neither an npm
  // bin nor a Python console script -- a pnpm layout, a Windows `.cmd` shim, a hand-rolled
  // wrapper. "Not detected" is honest; reporting it as the recorded identity would not be.
  const root = tempDir(t, 'kimi-identity')
  mkdirSync(join(root, 'bin'))
  const kimi = join(root, 'bin', 'kimi')
  writeFileSync(kimi, '#!/bin/sh\nexec something-else "$@"\n')
  const { result: detected, attempts } = offline(() => detectIdentity('kimi', kimi))
  assert.deepEqual(attempts, [], 'detection must not leave the machine')
  assert.ok('why' in detected, 'an unidentifiable layout must not resolve to an identity')
  assert.match(detected.why, /is neither an npm bin nor a Python console script/)
  const notice = identityNotice(KIMI_VERIFIED_IDENTITY, detected)
  assert.match(notice, /^kimi identity: not detected \(/)
  assert.match(notice, /the claims were recorded against `kimi` from PyPI kimi-cli/)
  assert.ok(!/DRIFT/.test(notice), 'not detected is not drift: it is the absence of an answer')
})

test('the identity notice is wired into the #201 run on this machine', () => {
  // The two tests above prove the comparison; this proves #201 actually emits it. A notice
  // that nothing calls is the failure the record exists to prevent, and it would pass both.
  // Reruns only #201 from this file, with the TAP reporter so diagnostics are on stdout, and
  // accepts any of the three answers: what is installed here is not this test's business.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  let stdout: string
  try {
    stdout = execFileSync(
      process.execPath,
      ['--test', '--test-reporter=tap', '--test-name-pattern=^#201 every claim', fileURLToPath(import.meta.url)],
      { encoding: 'utf8', stdio: 'pipe', env },
    )
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? ''
  }
  assert.match(stdout, /^\s*# (kimi identity: |KIMI IDENTITY DRIFT: )/m, `#201 emitted no kimi identity notice:\n${stdout}`)
})

/* ------------------------------------------------- which version is installed (#401) ------ */

/** `npm install -g @openai/codex`, at a version this test chooses. */
function npmCodex(root: string, version: string | undefined): string {
  const pkg = join(root, 'lib', 'node_modules', '@openai', 'codex')
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  mkdirSync(join(root, 'bin'))
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@openai/codex', ...(version ? { version } : {}), bin: { codex: 'bin/codex.js' } }),
  )
  writeFileSync(join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n')
  symlinkSync(join(pkg, 'bin', 'codex.js'), join(root, 'bin', 'codex'))
  return join(root, 'bin', 'codex')
}

/** Claude's native installer: `~/.local/bin/claude` linked to `versions/<version>`. */
function nativeClaude(root: string, dir: string, name: string): string {
  mkdirSync(join(root, dir), { recursive: true })
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, dir, name), '')
  symlinkSync(join(root, dir, name), join(root, 'bin', 'claude'))
  return join(root, 'bin', 'claude')
}

test('#401 an installed version that differs from the recorded one is reported as drift', (t) => {
  const codex = npmCodex(tempDir(t, 'source-version'), '9.8.7')
  const { result: notice, attempts } = offline(() => sourceVersionNotice('codex', 'codex-cli 9.1.0', codex))
  assert.deepEqual(attempts, [], 'detection must not leave the machine')
  assert.match(notice, /^CODEX VERSION DRIFT: installed codex is 9\.8\.7 \(npm @openai\/codex, \S+package\.json bin\.codex\)/)
  assert.match(notice, /its claims were read from "codex-cli 9\.1\.0"/)
  assert.match(notice, /Every green in this file about codex is evidence about 9\.8\.7, not 9\.1\.0\./)
})

test('#401 the Claude version is read off the versions/<version> path it resolves to', (t) => {
  const root = tempDir(t, 'source-version')
  const claude = nativeClaude(root, join('share', 'claude', 'versions'), '3.4.5')
  const { result, attempts } = offline(() => ({
    drift: sourceVersionNotice('claude', '3.4.4 (Claude Code)', claude),
    match: sourceVersionNotice('claude', '3.4.5 (Claude Code)', claude),
  }))
  assert.deepEqual(attempts, [], 'detection must not leave the machine')
  assert.match(result.drift, /^CLAUDE VERSION DRIFT: installed claude is 3\.4\.5 \(\S+versions\/3\.4\.5\)/)
  assert.match(result.match, /^claude version: checked against installed 3\.4\.5 \(\S+versions\/3\.4\.5\), the recorded "3\.4\.5 \(Claude Code\)"$/)
  assert.ok(!/DRIFT/.test(result.match), 'a match reports a match and nothing else')
})

test('#401 a matching version reports the match, read from the dist-info that declares the command', (t) => {
  // The trap from #401: a decoy distribution that declares no `kimi` and, since `pythonIdentity`
  // walks dist-infos in sorted order, is the FIRST one it reads. Reading "the first .dist-info"
  // would report its 0.8.0.
  const root = tempDir(t, 'source-version')
  const kimi = uvKimiCli(root)
  const decoy = join(root, 'uv', 'tools', 'kimi-cli', 'lib', 'python3.13', 'site-packages', 'agent_client_protocol-0.8.0.dist-info')
  mkdirSync(decoy)
  writeFileSync(join(decoy, 'entry_points.txt'), '[console_scripts]\nacp = acp:main\n')
  writeFileSync(join(decoy, 'METADATA'), 'Metadata-Version: 2.4\nName: agent-client-protocol\nVersion: 0.8.0\n')
  const infos = readdirSync(dirname(decoy)).filter((d) => d.endsWith('.dist-info')).sort()
  assert.equal(infos[0], 'agent_client_protocol-0.8.0.dist-info', 'the decoy must be the first dist-info read, or it proves nothing')
  const { result: notice, attempts } = offline(() => sourceVersionNotice('kimi', 'kimi, version 1.49.0', kimi))
  assert.deepEqual(attempts, [], 'detection must not leave the machine')
  assert.match(notice, /^kimi version: checked against installed 1\.49\.0 \(PyPI kimi-cli, \S+kimi_cli-1\.49\.0\.dist-info \[console_scripts\] kimi\), the recorded "kimi, version 1\.49\.0"$/)
  assert.ok(!/DRIFT|0\.8\.0/.test(notice), 'a match reports a match and nothing else')
})

test('#401 a layout with no readable version says where it looked and claims none', (t) => {
  const root = tempDir(t, 'source-version')
  const unversioned = npmCodex(join(root, 'npm'), undefined)
  mkdirSync(join(root, 'wrapper', 'bin'), { recursive: true })
  const wrapper = join(root, 'wrapper', 'bin', 'opencode')
  writeFileSync(wrapper, '#!/bin/sh\nexec something-else "$@"\n')
  const elsewhere = nativeClaude(join(root, 'claude'), 'opt', '3.4.5')
  const { result, attempts } = offline(() => ({
    unversioned: sourceVersionNotice('codex', 'codex-cli 9.1.0', unversioned),
    wrapper: sourceVersionNotice('opencode', '9.1.0', wrapper),
    elsewhere: sourceVersionNotice('claude', '3.4.5 (Claude Code)', elsewhere),
    absent: sourceVersionNotice('kimi', 'kimi, version 9.1.0', undefined),
  }))
  assert.deepEqual(attempts, [], 'detection must not leave the machine')
  assert.match(result.unversioned, /^codex version: not detected \(\S+@openai\/codex\/package\.json bin\.codex names @openai\/codex but no version\)/)
  assert.match(result.wrapper, /^opencode version: not detected \(\S+wrapper\/bin\/opencode is neither an npm bin nor a Python console script\)/)
  assert.match(result.elsewhere, /^claude version: not detected \(\S+opt\/3\.4\.5 is not a versions\/<version> path, so it names no version\)/)
  assert.match(result.absent, /^kimi version: not detected \(`kimi` is not on PATH, so no install was examined\); the claims were read from "kimi, version 9\.1\.0"$/)
  for (const notice of Object.values(result)) {
    assert.ok(!/DRIFT|checked against|installed \S+ is/.test(notice), `not detected is the absence of an answer: ${notice}`)
  }
})

test('#401 the version notice is wired into the #201 run, once per agent', () => {
  // As for the identity notice: the tests above prove the comparison, this proves #201 emits it.
  // Any of the three answers is accepted -- what is installed here is not this test's business.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  let stdout: string
  try {
    stdout = execFileSync(
      process.execPath,
      ['--test', '--test-reporter=tap', '--test-name-pattern=^#201 every claim', fileURLToPath(import.meta.url)],
      { encoding: 'utf8', stdio: 'pipe', env },
    )
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? ''
  }
  for (const agent of DECLARED.map(([a]) => a)) {
    const lines = stdout.match(new RegExp(`^\\s*# (${agent} version: |${agent.toUpperCase()} VERSION DRIFT: )`, 'gm')) ?? []
    assert.equal(lines.length, 1, `#201 must emit exactly one ${agent} version notice:\n${stdout}`)
  }
})
