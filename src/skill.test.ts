/**
 * The operator skill, pinned to the surface it describes.
 *
 * A skill is read by a machine that cannot tell the room has changed. A stale sentence in
 * `--help` costs a person a moment; a stale sentence here is followed confidently, which is
 * why this file exists and why it asserts against the REAL exports rather than a copy of
 * them. `HELP` is already checked this way against the CLI's own stdout; this is that rule
 * applied to the document an agent operator reads instead.
 *
 * What it cannot check is whether the advice is good. It can check that every command, flag,
 * seat prefix and outcome reason the skill names is one that exists.
 *
 *   node --test src/skill.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { tempDir } from './testkit/tempDir.ts'
import { COMMANDS } from './repl/session.ts'

const REPO = join(import.meta.dirname, '..')
const SKILL = readFileSync(join(REPO, '.claude', 'skills', 'conclave', 'SKILL.md'), 'utf8')

/** The CLI's own usage, as the CLI prints it. Not a copy. */
const USAGE = execFileSync('node', [join(REPO, 'bin', 'conclave.ts'), '--help'], { encoding: 'utf8' })

/**
 * Only what the skill presents AS code: fenced blocks and inline spans.
 *
 * Prose is not API. A first version scanned the whole document and refused `conclave run`,
 * which came from the sentence "Conclave runs two or more agent sessions" -- a false positive
 * that would have taught the next person to loosen the check rather than trust it.
 */
function codeOnly(md: string): string {
  const fences = [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]!)
  const spans = [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)
  return [...fences, ...spans].join('\n')
}
const CODE = codeOnly(SKILL)

/** Every top-level command the CLI dispatches, read off the source that dispatches them. */
function cliCommands(): Set<string> {
  const src = readFileSync(join(REPO, 'bin', 'conclave.ts'), 'utf8')
  return new Set([...src.matchAll(/command === '([a-z]+)'/g)].map((m) => m[1]!))
}

/** Every run reason the type declares. */
function runReasons(): Set<string> {
  const src = readFileSync(join(REPO, 'src', 'relay', 'observe.ts'), 'utf8')
  const block = src.slice(src.indexOf('export type RunReason'))
  return new Set([...block.slice(0, block.indexOf('\n\n')).matchAll(/\| '([a-z_]+)'/g)].map((m) => m[1]!))
}

test('#183 every console command the skill names exists', () => {
  // `/continue force` and friends appear as `/continue` plus a word; the command is the first
  // token, which is what `COMMANDS` holds.
  const named = new Set([...SKILL.matchAll(/(?:^|[\s`(])(\/[a-z]+)/g)].map((m) => m[1]!))
  assert.ok(named.size > 0, 'the skill must name some console commands, or this asserts nothing')
  for (const c of named) {
    assert.ok(COMMANDS.includes(c), `the skill names ${c}, which is not a console command`)
  }
})

test('#183 every conclave subcommand the skill names is dispatched by the CLI', () => {
  const cli = cliCommands()
  const named = new Set([...CODE.matchAll(/\bconclave ([a-z]+)/g)].map((m) => m[1]!))
  assert.ok(named.size > 0, 'the skill must name some subcommands')
  for (const c of named) {
    assert.ok(cli.has(c), `the skill names \`conclave ${c}\`, which the CLI does not dispatch`)
  }
})

test('#183 every flag the skill names appears in the CLI usage', () => {
  const named = new Set([...CODE.matchAll(/(--[a-z][a-z-]+)/g)].map((m) => m[1]!))
  assert.ok(named.size > 0, 'the skill must name some flags')
  for (const f of named) {
    // `--help` is handled before dispatch for every command and is deliberately not listed in
    // the usage it prints. Named here rather than filtered silently, so that if it ever IS
    // documented this exemption is visible enough to delete.
    if (f === '--help') continue
    assert.ok(USAGE.includes(f), `the skill names ${f}, which is not in \`conclave --help\``)
  }
})

test('#183 every outcome reason the skill names is a real RunReason', () => {
  const reasons = runReasons()
  // Read off the backticked list in the "How it ended" section, which is where the skill makes
  // claims a caller could gate on.
  const section = SKILL.slice(SKILL.indexOf('## How it ended'))
  const named = new Set([...section.matchAll(/^- `([a-z_]+)`/gm)].map((m) => m[1]!))
  assert.ok(named.size >= 5, `the skill must name several reasons, found ${named.size}`)
  for (const r of named) {
    assert.ok(reasons.has(r), `the skill names the outcome \`${r}\`, which is not a RunReason`)
  }
})

test('#183 the non-zero set the skill states matches the one the CLI applies', () => {
  // The claim most likely to be acted on unattended, and the one that silently rots: a reason
  // added to the exit-code set without the skill noticing would leave an operator treating a
  // failed run as a success.
  const src = readFileSync(join(REPO, 'bin', 'conclave.ts'), 'utf8')
  // The multi-line assignment, not the `let failed = false` above it -- which is what a
  // plain indexOf finds, and which contains no reasons at all.
  const at = src.indexOf('failed =\n')
  assert.ok(at > 0, 'the exit-code assignment must be findable')
  const block = src.slice(at, at + 400)
  const actual = new Set([...block.matchAll(/outcome\.reason === '([a-z_]+)'/g)].map((m) => m[1]!))
  // The SENTENCE, not a fixed window after it. A 200-character slice ran past the full stop
  // into the bullet list below and picked up `done` -- which would have failed for a reason
  // that had nothing to do with the claim being wrong.
  const from = SKILL.indexOf('exit non-zero on')
  assert.ok(from > 0, 'the skill must state the non-zero set')
  const sentence = SKILL.slice(from, SKILL.indexOf('.', from))
  const claimed = new Set([...sentence.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!))

  assert.ok(actual.size > 0, 'the exit-code set must have been found in the CLI')
  assert.deepEqual(
    [...claimed].sort(),
    [...actual].sort(),
    'the skill and the CLI disagree about which reasons exit non-zero',
  )
})

test('#183 the frontmatter is present and says when to use it', () => {
  // Without a description a skill is never selected, so it is not merely cosmetic.
  assert.match(SKILL, /^---\nname: conclave\ndescription: .+\n---/s)
  const description = /description: (.+)/.exec(SKILL)?.[1] ?? ''
  assert.ok(description.length > 40, 'the description decides whether the skill is loaded at all')
  assert.match(description, /conclave/i)
})

test('#183 the skill does not induce caution in place of describing mechanism', () => {
  // The rule agreed on #183. An operator too anxious to spawn agents is as broken as a
  // reckless one, and harder to spot because it presents as prudence. Cost is enforced by
  // `--dry-run`, the preflight refusals and the ceilings, none of which need the operator to
  // feel careful -- so the skill states what those DO rather than what to be worried about.
  for (const banned of [/\bbe careful\b/i, /\bexpensive\b/i, /\bcheaper\b/i, /\bavoid long\b/i, /\bbills? you\b/i]) {
    assert.doesNotMatch(SKILL, banned, `the skill should describe mechanism, not induce caution (${banned})`)
  }
  // And it should still say the things that make an operator able to act.
  assert.match(SKILL, /--dry-run/, 'the free way to check an invocation must be there')
  assert.match(SKILL, /forceable|--force/, 'a refusal an operator can override must say so')
})

/** The CLI, run with a throwaway HOME so nothing touches the real one. */
function cli(args: string[], home: string): { code: number; out: string } {
  const r = spawnSync('node', [join(REPO, 'bin', 'conclave.ts'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

test('#183 the skill is offered rather than installed for you', (t) => {
  // `install.sh` symlinks one binary and touches nothing else in $HOME. Writing into a user's
  // Claude configuration uninvited is a larger change to their environment than installing
  // conclave is, so the bare form only SAYS where it is.
  const home = tempDir(t, 'conclave-skill-home')
  const bare = cli(['skill'], home)
  assert.equal(bare.code, 0)
  assert.match(bare.out, /skill install/, 'it must say how to install it')
  assert.equal(
    existsSync(join(home, '.claude', 'skills', 'conclave', 'SKILL.md')),
    false,
    'asking where it is must not install it',
  )
})

test('#183 installing is idempotent, and never overwrites an edited copy unasked', (t) => {
  const home = tempDir(t, 'conclave-skill-home')
  const target = join(home, '.claude', 'skills', 'conclave', 'SKILL.md')

  assert.equal(cli(['skill', 'install'], home).code, 0)
  assert.equal(readFileSync(target, 'utf8'), SKILL, 'the installed copy is the bundled one')

  // Re-running is safe: identical content is a no-op rather than a refusal, or an operator
  // could not re-run the command after an upgrade without being told off.
  const again = cli(['skill', 'install'], home)
  assert.equal(again.code, 0)
  assert.match(again.out, /already installed/)

  // An edited copy is someone's work. Refused, not silently replaced.
  appendFileSync(target, '\nmy own notes\n')
  const edited = cli(['skill', 'install'], home)
  assert.equal(edited.code, 1, 'a differing copy must not be clobbered')
  assert.match(edited.out, /--force/, 'and the refusal must say how to override it')
  assert.match(readFileSync(target, 'utf8'), /my own notes/, 'the edit survives the refusal')

  assert.equal(cli(['skill', 'install', '--force'], home).code, 0)
  assert.doesNotMatch(readFileSync(target, 'utf8'), /my own notes/, '--force replaces it')
})

test('#183 the skill teaches current behaviour, not issue lore', () => {
  // A real operator was observed reasoning from conclave#171 -- "a withheld note arms the
  // authority_conflict detector against every later instruction touching those files" -- and
  // BROADCASTING a note it had judged should be restricted, to dodge it. The recollection of
  // the defect was accurate. The defect was fixed and shipped in v0.5.9, three releases before
  // the run in question.
  //
  // Bug lore rots in the dangerous direction: an operator avoiding a fixed defect makes worse
  // decisions and feels well-informed doing it. So the skill states what the code does now and
  // cites no issue numbers -- there is no version of "#171 was a problem" that stays true and
  // useful, and a reader cannot tell a live citation from a stale one.
  const body = SKILL.slice(SKILL.indexOf('---', 4))
  assert.doesNotMatch(body, /#\d{2,4}\b/, 'the skill must not cite issue numbers as behaviour')

  // And it must carry the thing that operator actually needed: what the pause wants.
  assert.match(SKILL, /authority_conflict/, 'the pause an operator will meet must be described')
  assert.match(SKILL, /still\W{0,2}\s*withheld from/, 'and the repair that clears it')
})
