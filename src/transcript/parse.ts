/**
 * Transcript record -> turn view, per agent.
 *
 * Schemas verified by inspection on 2026-08-05 (claude 2.1.222, codex 0.146.0) and
 * recorded in spikes/transcripts/FINDINGS.md. Both formats are undocumented and
 * version-specific; re-run spikes/transcripts/characterize.py after a toolchain bump
 * and treat a diff in its output as a diff in this contract.
 *
 * The two agents differ in what their transcripts can even express, which is why this
 * is per-agent parsing into a common view rather than one parser with flags:
 *
 *   completion    claude: Stop hook only      codex: task_complete, in-transcript
 *   cancellation  claude: nothing, anywhere   codex: turn_aborted, with a reason
 *   correlation   claude: prompt_id           codex: turn_id
 */

import type { TurnRecord } from '../contract/session.ts'
import { turnKey } from '../contract/session.ts'

export interface ParsedTranscript {
  turns: TurnRecord[]
  /** The transcript declared a compaction. Distinct from a detected rewrite. */
  declaredCompaction: boolean
  sessionId?: string | undefined
}

/**
 * A tool input, flattened to text for attribution evidence.
 *
 * Whole-value serialization rather than picking out known path fields. A `file_path` and an
 * `apply_patch` header are both substrings of the serialized form, so one mechanism covers
 * every tool on both agents, including the shell commands that carry most real file work.
 *
 * Capped, because a `Write` input embeds the entire file content and this is retained for
 * the life of the session. The cap is far above any realistic path-bearing prefix; it exists
 * to bound a pathological single call, not to trim ordinary ones.
 */
const ARGS_CAP = 64 * 1024

function serializeArgs(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined
  let s: string
  if (typeof input === 'string') {
    s = input
  } else {
    try {
      s = JSON.stringify(input) ?? ''
    } catch {
      // A transcript record that will not serialize is not worth failing a parse over.
      return undefined
    }
  }
  if (!s) return undefined
  return s.length > ARGS_CAP ? s.slice(0, ARGS_CAP) : s
}

// --- Claude Code -------------------------------------------------------------------

const CLAUDE_COMPACTION_ATTACHMENTS = new Set(['compact_file_reference'])

export function parseClaude(records: Record<string, any>[]): ParsedTranscript {
  const turns: TurnRecord[] = []
  let declaredCompaction = false
  let sessionId: string | undefined
  let current: TurnRecord | undefined

  for (const d of records) {
    sessionId ??= d.sessionId ?? d.session_id

    switch (d.type) {
      case 'attachment': {
        const at = d.attachment?.type
        if (at && CLAUDE_COMPACTION_ATTACHMENTS.has(at)) declaredCompaction = true
        break
      }
      case 'user': {
        const content = d.message?.content
        if (typeof content === 'string') {
          // A plain-string user message is a prompt; a list is tool results coming back.
          current = {
            // Claude Code has no per-turn id in the transcript itself -- prompt_id
            // arrives only via hooks. Index keeps the view usable standalone; the
            // adapter overwrites it once a hook supplies the real key.
            key: turnKey(`claude-transcript-turn-${turns.length}`),
            prompt: content,
            state: 'in_progress',
            toolCalls: [],
          }
          turns.push(current)
        } else if (Array.isArray(content) && current) {
          for (const block of content) {
            if (block?.type === 'tool_result') {
              const last = current.toolCalls.at(-1)
              if (last) last.failed = Boolean(block.is_error)
            }
          }
        }
        break
      }
      case 'assistant': {
        if (!current) break
        const msg = d.message ?? {}
        for (const block of msg.content ?? []) {
          if (block?.type === 'text' && block.text) {
            // Blank line between blocks. Without it "…what exists.Now let me see…" is what
            // both the human and the other participant read.
            current.assistantText = current.assistantText
              ? `${current.assistantText}\n\n${block.text}`
              : block.text
            // The last text block of the turn is its report; earlier ones are narration.
            current.report = block.text
          } else if (block?.type === 'tool_use') {
            // `input` carries `file_path` on Write/Edit and `command` on Bash. Verified
            // present on 1883/1883 Edit and 475/475 Write calls across 173 sessions; Bash
            // is 81% of all calls, so the command text is the bulk of the evidence.
            current.toolCalls.push({
              tool: String(block.name),
              failed: false,
              args: serializeArgs(block.input),
            })
          }
        }
        // Only `end_turn` closes a turn. `tool_use` means the model is mid-flight, and
        // a turn with a failing tool still completes normally.
        if (msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence') {
          current.state = 'completed'
          current.confidence = 'inferred'
          current.provenance = [
            { source: 'transcript', detail: `stop_reason=${msg.stop_reason}` },
            {
              source: 'transcript',
              detail: 'transcript-only; the Stop hook is what proves completion',
              caveat: true,
            },
          ]
        }
        break
      }
    }
  }

  return { turns, declaredCompaction, sessionId }
}

// --- Codex -------------------------------------------------------------------------

export function parseCodex(records: Record<string, any>[]): ParsedTranscript {
  const turns: TurnRecord[] = []
  const byId = new Map<string, TurnRecord>()
  let declaredCompaction = false
  let sessionId: string | undefined
  let current: TurnRecord | undefined

  const ensure = (id: string | undefined): TurnRecord | undefined => {
    if (id && byId.has(id)) return byId.get(id)
    if (!id) return current
    const rec: TurnRecord = {
      key: turnKey(id),
      // Left empty on purpose: `task_started` precedes `user_message`, so the prompt is
      // filled in when it arrives rather than copied from a previous turn.
      prompt: '',
      state: 'in_progress',
      toolCalls: [],
    }
    byId.set(id, rec)
    turns.push(rec)
    return rec
  }

  for (const d of records) {
    if (d.type === 'compacted') {
      declaredCompaction = true
      continue
    }
    if (d.type === 'session_meta') {
      sessionId = d.payload?.session_id ?? d.payload?.id
      continue
    }

    const p = d.payload ?? {}

    if (d.type === 'event_msg') {
      switch (p.type) {
        case 'context_compacted':
          declaredCompaction = true
          break
        case 'user_message': {
          // Observed on 0.146.0: `task_started` is written BEFORE `user_message`, so by
          // the time the prompt appears the turn usually already exists. Creating one
          // here unconditionally produced a phantom second turn per exchange.
          const text = String(p.message ?? '')
          if (current && current.prompt === '') {
            current.prompt = text
          } else {
            current = {
              key: turnKey(`codex-pending-${turns.length}`),
              prompt: text,
              state: 'in_progress',
              toolCalls: [],
            }
            turns.push(current)
          }
          break
        }
        case 'task_started': {
          // Adopt only a record that has not been given a real id yet.
          //
          // This used to adopt `current` whenever a turn_id existed, which meant the SECOND
          // exchange's `task_started` renamed the FIRST exchange's completed record. Its
          // `user_message` then found a non-empty prompt and created a fresh record, so
          // every codex transcript ended with a phantom `in_progress` turn carrying the
          // previous turn's report.
          //
          // Nothing noticed because the phantom duplicated a real report, so the relay read
          // plausible prose. It surfaced only when `#exchange` began waiting for the last
          // turn to leave `in_progress` — which it never did, costing the settle window on
          // every advisor turn and logging a truncation warning about a turn that had
          // completed normally.
          const pending = current?.key.startsWith('codex-pending-') === true
          if (current && p.turn_id && pending) {
            current.key = turnKey(p.turn_id)
            byId.set(p.turn_id, current)
          } else {
            current = ensure(p.turn_id)
          }
          if (current) current.startedAt = Date.parse(d.timestamp ?? '') || undefined
          break
        }
        case 'task_complete': {
          const rec = ensure(p.turn_id) ?? current
          if (rec) {
            rec.state = 'completed'
            rec.confidence = 'proven'
            rec.provenance = [{ source: 'transcript', detail: 'task_complete' }]
            if (p.last_agent_message) {
              const final = String(p.last_agent_message)
              rec.report = final
              // `assistantText` is the narration and must contain the closing message too;
              // only append when the running text does not already end with it, since
              // `agent_message` may have carried the same block already.
              if (!rec.assistantText) rec.assistantText = final
              else if (!rec.assistantText.endsWith(final)) rec.assistantText += `\n\n${final}`
            }
          }
          break
        }
        case 'turn_aborted': {
          // The record Claude Code has no equivalent of.
          const rec = ensure(p.turn_id) ?? current
          if (rec) {
            rec.state = 'cancelled'
            rec.confidence = 'proven'
            rec.provenance = [
              { source: 'transcript', detail: `turn_aborted reason=${p.reason}` },
            ]
          }
          break
        }
        case 'agent_message':
          if (current && p.message) {
            const text = String(p.message)
            current.assistantText = current.assistantText
              ? `${current.assistantText}\n\n${text}`
              : text
            current.report = text
          }
          break
      }
      continue
    }

    if (d.type === 'response_item' && current) {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        // The two record types carry arguments in DIFFERENT fields, and the split is not
        // marginal: across 654 sessions, `custom_tool_call.input` holds 2839 calls and
        // `function_call.arguments` holds 1454. Reading only `arguments` -- the obvious
        // guess, and the one this nearly shipped with -- would see 34% of Codex tool use.
        const args = p.type === 'custom_tool_call' ? p.input : p.arguments
        current.toolCalls.push({
          tool: String(p.name ?? p.tool_name ?? 'unknown'),
          failed: false,
          args: serializeArgs(args),
        })
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const last = current.toolCalls.at(-1)
        if (last) last.failed = Boolean(p.output?.success === false || p.is_error)
      }
    }
  }

  return { turns, declaredCompaction, sessionId }
}

export function parserFor(agent: string): (r: Record<string, any>[]) => ParsedTranscript {
  if (agent === 'codex') return parseCodex
  if (agent === 'claude') return parseClaude
  throw new Error(`no transcript parser for agent ${agent}`)
}
