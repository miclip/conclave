/**
 * A command policy is a list of permissions to type text into ANOTHER PROGRAM, so every line
 * of it is a claim about that program with an expiry date.
 *
 *   node --test src/registry/commandPolicy.test.ts
 *
 * The guard that matters most is the one against silent decay, and it is the same one
 * `hookEventNames.test.ts` runs for the same reason: neither an allowance nor a refusal
 * produces an error when the command it names stops existing. An allowance goes on permitting
 * a command that does nothing; a refusal goes on guarding against a hazard that is gone, while
 * reading to any later reader as evidence that someone checked. So every CONSIDERED command on
 * both pty adapters, refusals included, is searched for in the installed bundle on every run.
 *
 * What this cannot prove is that a command WORKS -- that needs a live seat, and no adapter
 * reads the composer's error text in any case. It proves the weaker and more perishable
 * thing: that the name is still one the installed program knows.
 *
 * The THIRD state gets its own guards below. `unsupported` and absence both refuse every
 * command, so nothing about the refusal itself distinguishes them, and the tests have to.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { defaultRegistry } from './builtin.ts'
import {
  CLAUDE_COMMAND_POLICY,
  CODEX_COMMAND_POLICY,
  NO_COMPOSER_COMMAND_POLICY,
  ruleOnCommand,
} from './commandPolicy.ts'
import { ABSENT_LITERAL_CANARY, installedBundle } from './installedBundle.ts'
import type { CommandPolicy } from './types.ts'

/** Narrow to the declared arm, failing with a useful message rather than a type error. */
function declared(policy: CommandPolicy | undefined, who: string) {
  assert.ok(policy, `${who} must carry a policy`)
  assert.equal(policy.kind, 'declared', `${who} must declare a list, not ${policy.kind}`)
  return policy as Extract<CommandPolicy, { kind: 'declared' }>
}

const PINNED: ReadonlyArray<readonly [string, string, Extract<CommandPolicy, { kind: 'declared' }>]> = [
  ['claude', '2.1.258 (Claude Code)', CLAUDE_COMMAND_POLICY as Extract<CommandPolicy, { kind: 'declared' }>],
  ['codex', 'codex-cli 0.147.0', CODEX_COMMAND_POLICY as Extract<CommandPolicy, { kind: 'declared' }>],
]

for (const [command, version, policy] of PINNED) {
  test(`every command the ${command} policy considered is one the installed ${command} still has`, (t) => {
    // Asserted BEFORE the skip below, deliberately. Everything after it degrades to a skip on
    // a machine without that CLI installed, and a guard that can be skipped must not be the
    // only thing standing between an emptied list and a green run.
    assert.ok(
      policy.commands.length >= 9,
      `the search below is worthless over a list this short; it must cover every ${command} command considered`,
    )

    const found = installedBundle(command)
    if ('why' in found) {
      t.diagnostic(`skipped: ${found.why}`)
      return
    }
    t.diagnostic(`checked against ${found.at} (${found.bytes.byteLength}B)`)

    assert.equal(
      found.bytes.includes(ABSENT_LITERAL_CANARY),
      false,
      'the canary was found, so the search matches anything and the assertions below are vacuous',
    )

    // Refusals are searched exactly as allowances are. A refusal naming a command the CLI no
    // longer has is stale in the more dangerous direction: it looks like a live guard.
    const missing = policy.commands.filter((c) => !found.bytes.includes(c.source))
    assert.deepEqual(
      missing.map((c) => `${c.command} (${c.disposition})`),
      [],
      `these declarations were read from a ${command} that is no longer the installed one, so each must be re-derived against it -- an allowance that permits nothing and a refusal that guards nothing both read as checked`,
    )
  })

  test(`the ${command} policy pins the version its literals were read from`, () => {
    // Verbatim `--version`, the same freshness convention `GradedClaim` sets: a staleness
    // check is a string comparison and needs no parser.
    assert.equal(policy.sourceVersion, version)
  })
}

test('a Codex source literal is specific enough to mean something, which a bare name would not be', (t) => {
  // The reason the Codex entries pin descriptions rather than names, made into a check rather
  // than left as an assertion in a comment. Codex is a Rust binary that interns its command
  // names into a packed table, and every short name in it also occurs elsewhere in 220MB. If
  // `compact` alone were treated as evidence, the guard above would pass on a binary that had
  // dropped the command entirely.
  const found = installedBundle('codex')
  if ('why' in found) {
    t.diagnostic(`skipped: ${found.why}`)
    return
  }
  assert.ok(
    found.bytes.includes('logoutquitexitrollout'),
    'the interned name table has moved, so the two entries whose only evidence is that run need re-deriving',
  )
  // The demonstration: the bare name is present in a context that has nothing to do with the
  // command, so a name search cannot distinguish a live command from a coincidence.
  assert.ok(
    found.bytes.includes('compact'),
    'if even this were absent the point below would be moot, and the /compact entry would already have failed above',
  )
  const description = CODEX_COMMAND_POLICY.kind === 'declared'
    ? CODEX_COMMAND_POLICY.commands.find((c) => c.command === '/compact')?.source
    : undefined
  assert.equal(
    description,
    'summarize conversation to prevent hitting the context limit',
    'the /compact entry must pin the description, not the name, or it proves nothing about the command',
  )
})

test('Claude allows exactly the work-mode changes and refuses exactly the rest', () => {
  // Read through the registry rather than off the constant, so the WIRING is pinned too.
  const policy = declared(defaultRegistry().get('claude').commandPolicy, 'claude')
  const by = (d: string) => policy.commands.filter((c) => c.disposition === d).map((c) => c.command).sort()

  assert.deepEqual(
    by('allowed'),
    ['/compact', '/loop'],
    '/compact preserves the conversation by summarising it; /loop changes how turns are dispatched. Nothing else found changes a mode without ending continuity or rewriting the operator’s setup',
  )
  assert.deepEqual(
    by('refused'),
    ['/clear', '/config', '/exit', '/hooks', '/model', '/permissions', '/quit', '/rewind'],
    'each of these either ends or discards the continuity the relay believes it has, or changes what the operator configured',
  )
})

test('Codex allows exactly /compact and /review, and refuses exactly the rest', () => {
  const policy = declared(defaultRegistry().get('codex').commandPolicy, 'codex')
  const by = (d: string) => policy.commands.filter((c) => c.disposition === d).map((c) => c.command).sort()

  assert.deepEqual(
    by('allowed'),
    ['/compact', '/review'],
    'the same rule as Claude applied to a different command surface: /compact summarises rather than discards, /review changes how the seat spends its turns',
  )
  assert.deepEqual(
    by('refused'),
    ['/archive', '/exit', '/fork', '/model', '/new', '/permissions', '/quit'],
    'three that end or discard the thread, two that end the seat, two that rewrite what the operator configured',
  )
})

test('the two pty policies apply one rule, not two: /compact and /model land the same way on both', () => {
  // The rule lives on `CommandPolicy` and is applied per CLI. If the same verb came out
  // differently on two adapters with no reason given, the rule would not be doing the deciding.
  for (const [agent, policy] of PINNED.map(([a, , p]) => [a, p] as const)) {
    const compact = policy.commands.find((c) => c.command === '/compact')
    const model = policy.commands.find((c) => c.command === '/model')
    assert.equal(compact?.disposition, 'allowed', `${agent} /compact is a work-mode change`)
    assert.equal(model?.disposition, 'refused', `${agent} /model rewrites operator configuration`)
  }
})

test('/model is refused because the launch-model report is immutable, not merely because it is configuration', () => {
  // Called out on its own because it is the case with a victim: the other refusals leave the
  // run unable to describe the seat, while this one leaves the run describing it WRONGLY. The
  // launch model is recorded once and never revised, so a mid-run switch does not update that
  // record -- it falsifies it. Asserted on BOTH pty adapters, because the report is the same
  // report either way.
  for (const [agent, , policy] of PINNED) {
    const entry = policy.commands.find((c) => c.command === '/model')
    assert.ok(entry, `${agent} must consider /model rather than leave it undeclared`)
    assert.equal(entry.disposition, 'refused')
    assert.match(
      entry.reason,
      /launch-model report|launch model is recorded once and never revised/,
      `${agent} must name the report that becomes false, or the refusal reads as taste`,
    )
  }
})

test('/hooks is refused on the ground that it can remove conclave’s own turn-completion evidence', () => {
  // The one configuration refusal that would break the orchestrator rather than misdescribe
  // it: the adapter learns a turn ended because `Stop` fires, and a seat that can edit its
  // hooks can unregister it.
  const entry = declared(CLAUDE_COMMAND_POLICY, 'claude').commands.find((c) => c.command === '/hooks')
  assert.ok(entry, '/hooks must be considered')
  assert.equal(entry.disposition, 'refused')
  assert.match(entry.reason, /Stop/, 'the reason must name the signal that would be lost')
})

test('/rewind is refused for discarding continuity backwards, which no other Claude refusal covers', () => {
  // `/clear` empties the context forwards; `/rewind` un-happens turns the relay has already
  // recorded and reported. Distinct enough to be its own entry rather than folded into /clear.
  const entry = declared(CLAUDE_COMMAND_POLICY, 'claude').commands.find((c) => c.command === '/rewind')
  assert.ok(entry, '/rewind must be considered')
  assert.equal(entry.disposition, 'refused')
  assert.match(entry.reason, /already recorded, attributed and reported/)
})

test('Codex /new is refused on parser evidence, not only on the general continuity clause', () => {
  // The Codex adapter latches its transcript path on the first hook that carries one and never
  // revises it, so a new chat is worse there than the same command would be on Claude, whose
  // adapter reassigns the path on every SessionStart. The refusal says so, because a reason
  // that generalised over both would hide the sharper failure.
  const entry = declared(CODEX_COMMAND_POLICY, 'codex').commands.find((c) => c.command === '/new')
  assert.ok(entry, '/new must be considered')
  assert.equal(entry.disposition, 'refused')
  assert.match(entry.reason, /latches the transcript path/)
})

test('the Codex parser really does latch its transcript path, so the reason above is not folklore', () => {
  // A claim about code in this repository, checked against that code. If the latch is ever
  // removed -- reassigning on every hook, as the Claude adapter does -- the /new reason stops
  // being true and this fails rather than going quietly stale.
  const src = readFileSync(join(import.meta.dirname, '..', 'adapters', 'codex.ts'), 'utf8')
  assert.match(
    src,
    /if \(d\.payload\['transcript_path'\] && !this\.#transcriptPath\)/,
    'the Codex adapter no longer latches the transcript path, so the /new refusal must be re-argued',
  )
})

test('Codex /compact is allowed on evidence that compaction stays inside the rollout being tailed', () => {
  // The one Codex allowance that had to be argued rather than assumed. `/new` is refused below
  // because it starts a rollout the latched transcript path cannot follow; a `/compact` that
  // did the same would have to be refused identically. It does not: `compacted` is a record
  // type WITHIN the rollout, and conclave's own Codex parser counts it by reading that type
  // out of the transcript it is already tailing. If that ever stops being how compaction
  // arrives, the allowance has to be re-argued, and this fails rather than going stale.
  const src = readFileSync(join(import.meta.dirname, '..', 'transcript', 'parse.ts'), 'utf8')
  assert.match(
    src,
    /d\.type === 'compacted'/,
    'the Codex parser no longer reads a compaction out of the rollout it is tailing, so /compact may now break the transcript latch the way /new does',
  )
  const entry = declared(CODEX_COMMAND_POLICY, 'codex').commands.find((c) => c.command === '/compact')
  assert.equal(entry?.disposition, 'allowed')
})

test('every declaration says why, and quotes what it was read from', () => {
  for (const [agent, , policy] of PINNED) {
    for (const c of policy.commands) {
      assert.ok(c.command.startsWith('/'), `${agent} ${c.command} must be spelled as it would be typed`)
      assert.ok(c.reason.trim().length > 0, `${agent} ${c.command} must say which clause of the rule decides it`)
      assert.ok(c.source.trim().length > 0, `${agent} ${c.command} must quote what its existence was read from`)
    }
  }
})

test('the run-per-turn adapters declare unsupported, which is not the same answer as a refusal list', () => {
  // A statement about the transport rather than about any verb. Collapsing it into a list of
  // refusals would say someone weighed those commands and said no; collapsing it into absence
  // would say nobody looked. Both misdescribe a structural fact.
  const r = defaultRegistry()
  for (const agent of ['opencode', 'kimi']) {
    const policy = r.get(agent).commandPolicy
    assert.ok(policy, `${agent} must carry a policy`)
    assert.equal(policy.kind, 'unsupported', `${agent} has no composer to deliver a command to`)
    assert.match(policy.reason, /run-per-turn, no composer/)
  }
})

test('no built-in is left undeclared: all four say something', () => {
  const r = defaultRegistry()
  for (const agent of ['claude', 'codex', 'opencode', 'kimi']) {
    assert.ok(r.get(agent).commandPolicy, `${agent} must not be left in the "nobody looked" state`)
  }
})

test('the no-composer reason is true of the code, not just of the sentence', () => {
  // `InputQueue` is the thing that types into a composer. If either run-per-turn adapter ever
  // acquires one, `NO_COMPOSER_COMMAND_POLICY` stops being the right answer for it, and this
  // fails rather than leaving a confident sentence guarding nothing.
  const importers: string[] = []
  for (const adapter of ['claude', 'codex', 'opencode', 'kimi']) {
    const src = readFileSync(join(import.meta.dirname, '..', 'adapters', `${adapter}.ts`), 'utf8')
    if (src.includes('InputQueue')) importers.push(adapter)
  }
  assert.deepEqual(
    importers.sort(),
    ['claude', 'codex'],
    'exactly the two adapters with a declared command list are the two that can type into a composer',
  )
})

test('exactly the two adapters with a declared list implement submitRaw, and through InputQueue', () => {
  // Three claims that have to agree or the policy is describing a capability the code does not
  // have: the seam's method exists on Claude and Codex, on neither of the others, and it goes
  // through the SAME `InputQueue.submit` every prompt goes through -- so a command cannot
  // interleave with a send at the same pty, and the ordering the relay relies on is the
  // queue's rather than a second path's.
  const implementers: string[] = []
  const viaQueue: string[] = []
  for (const adapter of ['claude', 'codex', 'opencode', 'kimi']) {
    const src = readFileSync(join(import.meta.dirname, '..', 'adapters', `${adapter}.ts`), 'utf8')
    if (/async submitRaw\(/.test(src)) implementers.push(adapter)
    if (/async submitRaw\([\s\S]{0,900}?this\.#input\.submit\(/.test(src)) viaQueue.push(adapter)
  }
  assert.deepEqual(implementers.sort(), ['claude', 'codex'], 'only the pty adapters can type at a composer')
  assert.deepEqual(viaQueue.sort(), ['claude', 'codex'], 'and each does it through the existing input queue, not a second write path')
})

test('an agent with no policy at all refuses every command, and says nobody looked', () => {
  const ruling = ruleOnCommand(undefined, '/compact')
  assert.equal(ruling.verdict, 'refused')
  assert.match(ruling.reason, /no command policy has been declared/)
})

test('an unsupported transport refuses every command for a different reason than an undeclared one', () => {
  // The distinction the union exists for. Both refuse; a caller that reported them
  // identically would make one of the two problems permanently invisible.
  const unsupported = ruleOnCommand(NO_COMPOSER_COMMAND_POLICY, '/compact')
  const undeclaredAgent = ruleOnCommand(undefined, '/compact')
  assert.equal(unsupported.verdict, 'refused')
  assert.match(unsupported.reason, /run-per-turn, no composer/)
  assert.notEqual(
    unsupported.reason,
    undeclaredAgent.reason,
    '"nowhere to type it" and "nobody read this CLI" must not arrive as the same explanation',
  )
})

test('an unsupported transport refuses even a command that is allowed elsewhere', () => {
  // /compact is allowed on both pty adapters. It is still refused here, because the refusal is
  // about the transport and not about the verb.
  assert.equal(ruleOnCommand(NO_COMPOSER_COMMAND_POLICY, '/compact').verdict, 'refused')
})

test('an allowed command is allowed, and the ruling carries the reason it was allowed for', () => {
  const ruling = ruleOnCommand(CLAUDE_COMMAND_POLICY, '  /compact focus on the failing test  ')
  assert.equal(ruling.verdict, 'allowed')
  assert.equal(ruling.command, '/compact')
  assert.equal(ruling.line, '/compact focus on the failing test', 'arguments survive; only the surrounding whitespace does not')
  assert.match(ruling.reason, /continuity-preserving/)
})

test('a command allowed on one adapter is refused on the other when only one declares it', () => {
  // /loop is a Claude skill and /review is a Codex command; neither exists on the other. The
  // policy is per adapter, so the same line must not resolve the same way for both.
  assert.equal(ruleOnCommand(CLAUDE_COMMAND_POLICY, '/loop').verdict, 'allowed')
  assert.equal(ruleOnCommand(CODEX_COMMAND_POLICY, '/loop').verdict, 'refused')
  assert.equal(ruleOnCommand(CODEX_COMMAND_POLICY, '/review').verdict, 'allowed')
  assert.equal(ruleOnCommand(CLAUDE_COMMAND_POLICY, '/review').verdict, 'refused')
})

test('a refused command is refused with its own declared reason, not a generic one', () => {
  const ruling = ruleOnCommand(CLAUDE_COMMAND_POLICY, '/clear')
  assert.equal(ruling.verdict, 'refused')
  assert.equal(ruling.command, '/clear')
  assert.match(ruling.reason, /Discards continuity/)
})

test('an undeclared command is refused, and is distinguishable from a declared refusal', () => {
  // Fails closed. `/resume`, `/context`, `/cost` and everything else nobody considered land
  // here, and the reason says "not declared" rather than borrowing a rule that was never
  // applied to them.
  const ruling = ruleOnCommand(CLAUDE_COMMAND_POLICY, '/resume')
  assert.equal(ruling.verdict, 'refused')
  assert.match(ruling.reason, /not declared in this agent’s command policy/)
})

test('a refused command nested in an allowed one is refused', () => {
  // `/loop 5m /clear` is a `/loop` by its first token and a repeating `/clear` by its effect.
  // A check that read only the head would let the plainest refusal in the policy through the
  // middle of its plainest allowance, once per interval.
  const ruling = ruleOnCommand(CLAUDE_COMMAND_POLICY, '/loop 5m /clear')
  assert.equal(ruling.verdict, 'refused')
  assert.equal(ruling.command, '/clear', 'the ruling must name the token that decided it, not the one that led')
})

test('a line with no slash command is refused rather than treated as one', () => {
  const ruling = ruleOnCommand(CLAUDE_COMMAND_POLICY, 'compact')
  assert.equal(ruling.verdict, 'refused')
  assert.match(ruling.reason, /not a slash command/)
})
