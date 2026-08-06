/**
 * Tool inputs surviving the parsers.
 *
 * These exist because attribution has no other source. No adapter emits `tool_use`, and
 * `PermissionRequest` does not fire for in-workspace writes, so the transcript is the only
 * place a participant's file activity is recorded at all — see `relay/authority.ts`.
 *
 * Every record shape below was taken from real transcripts on a working machine (654 Codex
 * sessions under `~/.codex/sessions`, 173 Claude sessions under `~/.claude/projects`),
 * not invented. `spikes/transcripts/FINDINGS.md` records the record TYPES but not their
 * argument fields, which is how the Codex split below was nearly missed.
 *
 *   node --test src/transcript/parse.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { parseClaude, parseCodex } from './parse.ts'

// --- Claude Code -------------------------------------------------------------------

function claudeTurn(...blocks: Record<string, unknown>[]): Record<string, any>[] {
  return [
    { type: 'user', message: { content: 'do the thing' } },
    { type: 'assistant', message: { content: blocks, stop_reason: 'end_turn' } },
  ]
}

test('claude: Write and Edit inputs keep their file_path', () => {
  // Present on 475/475 Write and 1883/1883 Edit calls across 173 sessions -- no observed
  // case of the field being absent.
  const { turns } = parseClaude(
    claudeTurn(
      { type: 'tool_use', name: 'Write', input: { file_path: '/repo/src/new.ts', content: 'x' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/old.ts', old_string: 'a', new_string: 'b' } },
    ),
  )
  const calls = turns[0]!.toolCalls
  assert.deepEqual(calls.map((c) => c.tool), ['Write', 'Edit'])
  assert.ok(calls[0]!.args!.includes('/repo/src/new.ts'))
  assert.ok(calls[1]!.args!.includes('/repo/src/old.ts'))
})

test('claude: a Bash command survives whole, because most file work happens there', () => {
  // Bash is 81% of all Claude tool calls, and in this repository ~65% of file mutations
  // are reachable ONLY through the command text. A parser that kept `file_path` and
  // dropped `command` would be blind to the majority of real edits.
  const cmd = `python3 - <<'PY'\np='src/relay/relay.ts'\nopen(p,'w').write('x')\nPY`
  const { turns } = parseClaude(claudeTurn({ type: 'tool_use', name: 'Bash', input: { command: cmd, description: 'edit' } }))
  assert.ok(turns[0]!.toolCalls[0]!.args!.includes('src/relay/relay.ts'))
})

test('claude: a tool call with no input yields no args rather than a placeholder', () => {
  const { turns } = parseClaude(claudeTurn({ type: 'tool_use', name: 'Mystery' }))
  assert.equal(turns[0]!.toolCalls[0]!.tool, 'Mystery')
  assert.equal(turns[0]!.toolCalls[0]!.args, undefined)
})

// --- Codex -------------------------------------------------------------------------

function codexTurn(...items: Record<string, unknown>[]): Record<string, any>[] {
  return [
    { type: 'event_msg', payload: { type: 'user_message', message: 'do the thing' } },
    ...items.map((payload) => ({ type: 'response_item', payload })),
  ]
}

test('codex: custom_tool_call carries its arguments in `input`, NOT `arguments`', () => {
  // The split that matters. Across 654 sessions, `custom_tool_call.input` holds 2839 calls
  // and `function_call.arguments` holds 1454. Reading only `arguments` -- the obvious guess
  // -- would see 34% of Codex tool use and silently miss the rest.
  const { turns } = parseCodex(
    codexTurn({
      type: 'custom_tool_call',
      name: 'exec',
      input: `const r = await tools.exec_command({"cmd":"rg --files src/relay/authority.ts"})`,
    }),
  )
  assert.equal(turns[0]!.toolCalls[0]!.tool, 'exec')
  assert.ok(turns[0]!.toolCalls[0]!.args!.includes('src/relay/authority.ts'))
})

test('codex: function_call carries its arguments in `arguments`', () => {
  const { turns } = parseCodex(
    codexTurn({ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls -la src/relay"}' }),
  )
  assert.equal(turns[0]!.toolCalls[0]!.tool, 'exec_command')
  assert.ok(turns[0]!.toolCalls[0]!.args!.includes('src/relay'))
})

test('codex: an apply_patch keeps the paths in its patch headers', () => {
  // Rare -- 8 calls in 654 sessions -- but the one Codex tool that names files outright.
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/relay/authority.ts',
    '@@',
    '-old',
    '+new',
    '*** Add File: src/relay/attribution.ts',
    '*** End Patch',
  ].join('\n')
  const { turns } = parseCodex(codexTurn({ type: 'custom_tool_call', name: 'apply_patch', input: patch }))
  const args = turns[0]!.toolCalls[0]!.args!
  assert.ok(args.includes('src/relay/authority.ts'))
  assert.ok(args.includes('src/relay/attribution.ts'), 'a multi-file patch must keep every header')
})

// --- both --------------------------------------------------------------------------

test('an oversized input is capped rather than retained whole', () => {
  // A `Write` input embeds the entire file, and this is held for the life of the session.
  // The cap bounds that; it is far above any realistic path-bearing prefix.
  const { turns } = parseClaude(
    claudeTurn({ type: 'tool_use', name: 'Write', input: { file_path: '/repo/big.ts', content: 'x'.repeat(200_000) } }),
  )
  const args = turns[0]!.toolCalls[0]!.args!
  assert.ok(args.length <= 64 * 1024)
  assert.ok(args.includes('/repo/big.ts'), 'the path must survive the truncation that trims the content')
})

test('tool names and failure still parse exactly as before', () => {
  // Retaining args must not disturb what these parsers already claimed. `failed` comes from
  // a later record and is matched positionally against the last call.
  const records = [
    { type: 'user', message: { content: 'go' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'false' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } },
  ]
  const { turns } = parseClaude(records)
  assert.equal(turns[0]!.toolCalls[0]!.tool, 'Bash')
  assert.equal(turns[0]!.toolCalls[0]!.failed, true)
})
