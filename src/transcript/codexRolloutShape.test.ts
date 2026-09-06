/**
 * The record shape `parseCodex` depends on, checked against what the installed Codex actually
 * writes (#242).
 *
 * `hookEventNames.test.ts` and `commandPolicy.test.ts` pin NAMES against the installed binary.
 * Nothing pinned the record SCHEMA, which is the larger claim and the one that broke: Codex
 * 0.153.4 stopped writing flat `user_message` records for ordinary turns and started wrapping
 * them --
 *
 *     {"type":"event_msg","payload":{"type":"item_completed","turn_id":"…",
 *       "item":{"type":"UserMessage","content":[{"type":"text","text":"…"}]}}}
 *
 * -- and `parseCodex` never read `payload.item.type`, so prompts came back empty on 4 of 71
 * turns across 25 real rollouts. Nothing failed. `parse.test.ts` builds its Codex records by
 * hand in the old shape, so it passed then and passes now, which is exactly the blind spot.
 *
 * This reads the CLI's own output instead. It cannot run everywhere and does not pretend to:
 * with no Codex installed, or no rollout from the installed version, it returns rather than
 * inventing a pass -- the same stance `hookEventNames.test.ts` takes when the bundle is absent.
 *
 * It asserts a RATE, not a single success. One recovered prompt would have passed throughout
 * the outage: 4 of 71 turns still carried one, because the flat records have not been removed,
 * only displaced.
 *
 * Reads only counts out of the rollouts. Their content is the operator's own sessions and none
 * of it is printed, asserted on, or written anywhere.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { parseCodex } from './parse.ts'

/** The installed CLI's version, or undefined when there is no Codex to ask. */
function installedCodexVersion(): string | undefined {
  try {
    const out = execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 10_000 })
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1]
  } catch {
    return undefined
  }
}

/** Rollouts written by that exact version, newest first, capped. */
function rolloutsFor(version: string): string[] {
  try {
    const out = execFileSync(
      'bash',
      ['-c', `grep -rl '"cli_version":"${version}"' "$HOME/.codex/sessions" 2>/dev/null | head -25`],
      { encoding: 'utf8', timeout: 60_000 },
    )
    return out.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

test('#242 parseCodex recovers prompts from rollouts the INSTALLED codex actually wrote', () => {
  const version = installedCodexVersion()
  if (!version) return
  const files = rolloutsFor(version)
  // No rollouts from this version yet is not a failure: a fresh machine, or a version just
  // upgraded. It is the honest answer to a question this machine cannot be asked.
  if (files.length === 0) return

  let turns = 0
  let withPrompt = 0
  for (const file of files) {
    const records = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          return undefined
        }
      })
      .filter((r): r is Record<string, unknown> => r !== undefined)
    for (const t of parseCodex(records).turns) {
      turns += 1
      if ((t.prompt ?? '').length > 0) withPrompt += 1
    }
  }
  if (turns === 0) return

  const rate = withPrompt / turns
  // Two thirds, not all of them. Some turns legitimately carry no prompt -- a review-mode
  // session writes `task_started` and `task_complete` under DIFFERENT turn ids, so a record is
  // created for the second with nothing to fill it. That is 2 of 71 here and is not what this
  // guards. The outage this exists to catch took the rate to 0.06.
  assert.ok(
    rate >= 0.66,
    `codex ${version}: prompts recovered on ${withPrompt} of ${turns} turns across ` +
      `${files.length} real rollouts (${(rate * 100).toFixed(1)}%). parseCodex reads a record ` +
      `shape this version no longer writes — check payload.item.type against a fresh rollout (#242).`,
  )
})

test('#242 a wrapped AgentMessage is read despite its content block saying "Text", not "text"', () => {
  // The casing is not consistent within one rollout: a `UserMessage` writes `{"type":"text"}`
  // and an `AgentMessage` writes `{"type":"Text"}`. Both spellings are copied from records
  // written by codex-cli 0.153.4.
  //
  // Matching `'text'` exactly still recovers every PROMPT, so the rate guard above stays green,
  // and reports keep arriving from `task_complete.last_agent_message` — so the loss is masked
  // twice over and shows up only where that fallback is absent. Asserted here without a
  // `task_complete`, which is the one condition that makes it visible.
  const wrapped = (kind: string, blockType: string, text: string) => ({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      turn_id: 'turn-1',
      item: { type: kind, id: 'i1', content: [{ type: blockType, text }] },
    },
  })

  const { turns } = parseCodex([
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    wrapped('UserMessage', 'text', 'the prompt'),
    wrapped('AgentMessage', 'Text', 'the report'),
  ])

  assert.equal(turns.length, 1)
  assert.equal(turns[0]?.prompt, 'the prompt')
  assert.equal(turns[0]?.report, 'the report', 'the capital-T block is the report, and nothing else supplies it here')
})
