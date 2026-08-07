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

test('narration and report are separated, and the narration is readable', () => {
  // Two failures in one: blocks were concatenated with no separator ("…exists.Now let me…"),
  // and the whole concatenation was routed to the other participant — which answers a
  // stated intention rather than a result.
  const parsed = parseClaude([
    { type: 'user', message: { content: 'do the thing' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: "I'll start by finding the relevant code." },
          { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'text', text: 'Now the guard report shape.' },
          { type: 'text', text: 'Done. guard --json is in.' },
        ],
        stop_reason: 'end_turn',
      },
    },
  ])
  const turn = parsed.turns.at(-1)!
  assert.equal(turn.report, 'Done. guard --json is in.', 'the closing message alone')
  assert.match(turn.assistantText!, /finding the relevant code\.\n\nNow the guard report shape/)
  assert.ok(
    turn.assistantText!.includes('Done. guard --json is in.'),
    'the narration still contains everything, including the close',
  )
})

test('codex turns do not leave a phantom, and reports align with their prompts', () => {
  // Record order verified against real rollouts: `task_started` precedes `user_message`.
  //
  // The second exchange's `task_started` used to adopt the FIRST exchange's completed
  // record, so its `user_message` created a fresh one and every transcript ended with a
  // phantom `in_progress` turn carrying the previous turn's report. Reports were off by one
  // against prompts, and the relay only read plausible prose because the phantom duplicated
  // the last real report.
  const rows = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'first prompt' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T1', last_agent_message: 'first answer' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T2' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'second prompt' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T2', last_agent_message: 'second answer' } },
  ]
  const { turns } = parseCodex(rows)

  assert.equal(turns.length, 2, 'two exchanges, two turns — no phantom')
  assert.deepEqual(
    turns.map((t) => t.state),
    ['completed', 'completed'],
    'a trailing in_progress turn makes every settle window expire',
  )
  assert.deepEqual(turns.map((t) => t.prompt), ['first prompt', 'second prompt'])
  assert.deepEqual(
    turns.map((t) => t.report),
    ['first answer', 'second answer'],
    'each report belongs to its own prompt',
  )
})

test('a task_complete carrying an error is not a completion (#35)', () => {
  // Observed live: Codex returned `usage_limit_exceeded` -- the workspace was out of credits
  // -- and the record still said `task_complete`, because the turn's machinery completed.
  // What it produced was a failure.
  //
  // Grading that `completed` made it indistinguishable from a turn that legitimately said
  // nothing, so the relay forwarded an empty instruction, the implementer asked for a resend,
  // and the run churned rounds toward its budget instead of failing with the real reason.
  const { turns } = parseCodex([
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'do the thing' } },
    {
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'T1',
        last_agent_message: null,
        error: {
          message: 'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.',
          codex_error_info: 'usage_limit_exceeded',
        },
      },
    },
  ])

  assert.equal(turns.length, 1)
  assert.equal(turns[0]!.state, 'unknown_abnormal_end')
  assert.equal(turns[0]!.confidence, 'proven', 'the record states it plainly; nothing is inferred')
  assert.match(turns[0]!.provenance![0]!.detail, /usage_limit_exceeded/)
  assert.match(turns[0]!.provenance![0]!.detail, /out of credits/, 'the vendor message is carried')
  // No report. Inventing one from the error text would put the vendor's words in the
  // participant's mouth and route them onward as though the advisor had said them.
  assert.equal(turns[0]!.report, undefined)
})

test('an ordinary task_complete with no message is still a completion', () => {
  // The control. An errored turn and a turn that simply said nothing must not be conflated
  // in EITHER direction -- a run that legitimately produces no closing message is normal.
  const { turns } = parseCodex([
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'do the thing' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T1', last_agent_message: null } },
  ])
  assert.equal(turns[0]!.state, 'completed')
})
