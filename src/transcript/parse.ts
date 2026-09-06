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
  /**
   * How many compactions the transcript declares.
   *
   * A COUNT, not a flag, because the flag could not distinguish one compaction from five and
   * the generation counter needs the difference. Claude Code appends its markers -- verified
   * against a real 57,493-line transcript carrying five of them at lines 2194 through 12184,
   * with records intact on both sides -- so a transcript accumulates markers rather than
   * being rewritten around them.
   */
  compactions: number
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

/**
 * What Claude Code writes into the transcript when a turn is interrupted (#225).
 *
 * It arrives as a USER message whose content is a plain string, which is the same shape as a
 * prompt -- so without this it opens a new turn whose prompt is the marker, leaves the real
 * turn `in_progress` forever, and hides the one piece of evidence that the turn ended.
 *
 * This matters beyond tidiness. The #174 retry may only re-type a message once the CHILD has
 * confirmed the turn ended, and no hook says so: `SessionEnd`, `Stop` and `StopFailure` are the
 * only closures Claude Code dispatches, and `StopFailure` fires for API errors -- rate limits,
 * auth -- not for an interruption. Verified against the installed bundle rather than believed:
 * its full hook list carries no interruption event at 2.1.261, and `claudeInterrupted.test.ts`
 * pins both halves of that so the next version cannot quietly change either.
 *
 * So the transcript is the only place the child records it, and reading it is what makes the
 * retry reachable on a Claude seat at all. The trailing `[^\]]*` is the program's own: it
 * matches the marker with or without the suffix Claude Code appends.
 */
export const CLAUDE_INTERRUPTION = /^\[Request interrupted by user[^\]]*\]/

export function parseClaude(records: Record<string, any>[]): ParsedTranscript {
  const turns: TurnRecord[] = []
  let compactions = 0
  let sessionId: string | undefined
  let current: TurnRecord | undefined

  for (const d of records) {
    sessionId ??= d.sessionId ?? d.session_id

    switch (d.type) {
      case 'attachment': {
        const at = d.attachment?.type
        if (at && CLAUDE_COMPACTION_ATTACHMENTS.has(at)) compactions += 1
        break
      }
      case 'user': {
        const content = d.message?.content
        if (typeof content === 'string' && CLAUDE_INTERRUPTION.test(content.trim())) {
          // NOT a prompt, though it is shaped exactly like one. The child is recording that the
          // turn above it was interrupted, so it CLOSES that turn rather than opening another.
          //
          // `cancelled` rather than a new outcome: the union already says what this is, and its
          // own note is that cancellation is known "because we caused it". Here the child says
          // so as well, which is the difference between our record of typing ESC and evidence
          // the child acted on it (#225).
          if (current) {
            current.state = 'cancelled'
            current = undefined
          }
        } else if (typeof content === 'string') {
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
          } else if (block?.type === 'thinking') {
            // #198: COUNTED, never accumulated. The reasoning text is not narration and has no
            // audience here; what the count buys is a liveness signal for a state that produces
            // no other one -- Claude Code writes each thinking block as its own transcript
            // entry, so the count grows while a turn is otherwise silent.
            current.thinkingCount = (current.thinkingCount ?? 0) + 1
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

  return { turns, declaredCompaction: compactions > 0, compactions, sessionId }
}

/**
 * How an errored `task_complete` announces itself in a turn's provenance.
 *
 * Exported and matched on rather than re-typed, because two places read it: the parser writes
 * it, and the Codex adapter recovers the error text from it when rebuilding transcript evidence
 * for the tracker. A prose string matched by `startsWith` in one file and written in another is
 * a rename away from silently classifying an errored turn as an ordinary one -- which is #35
 * arriving a second time, through the reconciliation path instead of the parser.
 */
export const TASK_COMPLETE_ERROR = 'task_complete carried an error -- '

// --- Codex -------------------------------------------------------------------------

export function parseCodex(records: Record<string, any>[]): ParsedTranscript {
  const turns: TurnRecord[] = []
  const byId = new Map<string, TurnRecord>()
  let compactions = 0
  let sessionId: string | undefined
  let current: TurnRecord | undefined

  /**
   * The text of a wrapped item, from the `content` blocks Codex writes inside it (#242).
   *
   * The block discriminator is NOT consistently cased: a `UserMessage` writes
   * `{"type":"text"}` and an `AgentMessage` writes `{"type":"Text"}`, in the same rollout.
   * Compared case-insensitively for that reason -- matching one spelling recovers the prompt
   * and silently drops every report, which is the more expensive half.
   */
  const itemText = (item: Record<string, unknown>): string => {
    const blocks = Array.isArray(item['content']) ? (item['content'] as Record<string, unknown>[]) : []
    return blocks
      .filter((b) => String(b?.['type'] ?? '').toLowerCase() === 'text')
      .map((b) => String(b?.['text'] ?? ''))
      .filter(Boolean)
      .join('\n')
  }

  /**
   * A prompt arriving, from either record shape.
   *
   * Shared so the wrapped and flat paths cannot come to disagree. The rule is the flat one's,
   * unchanged: `task_started` is written BEFORE the prompt, so the turn usually exists already
   * and adopting it is right; creating one unconditionally produced a phantom second turn per
   * exchange.
   */
  const adoptPrompt = (text: string): void => {
    if (current && current.prompt === '') {
      current.prompt = text
      return
    }
    current = {
      key: turnKey(`codex-pending-${turns.length}`),
      prompt: text,
      state: 'in_progress',
      toolCalls: [],
    }
    turns.push(current)
  }

  /** A report arriving, from either record shape. The flat branch's rule, unchanged. */
  const adoptReport = (text: string): void => {
    if (!current) return
    current.assistantText = current.assistantText ? `${current.assistantText}\n\n${text}` : text
    current.report = text
  }

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
      compactions += 1
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
          compactions += 1
          break
        case 'item_completed': {
          // Codex 0.153.4 does not write flat `user_message` / `agent_message` for ordinary
          // turns any more. It wraps them (#242):
          //
          //   {"type":"event_msg","payload":{"type":"item_completed","turn_id":"…",
          //     "item":{"type":"UserMessage","content":[{"type":"text","text":"…"}]}}}
          //
          // The discriminator is `payload.item.type`. Measured with the shipped parser over 25
          // real rollouts written by 0.153.4: prompts were recovered on 4 of 71 turns. Reports
          // mostly survived only because `task_complete.last_agent_message` is a second source
          // for them, and the prompt had no equivalent -- so a Codex turn reconstructed from
          // its transcript carried no prompt text at all.
          //
          // BOTH shapes are read rather than one swapped for the other: flat records still
          // appear occasionally on 0.153.4, so the old path is not dead, just displaced.
          const item = (p.item ?? {}) as Record<string, unknown>
          const kind = String(item['type'] ?? '')
          if (kind === 'UserMessage' || kind === 'AgentMessage') {
            const text = itemText(item)
            if (text) {
              if (kind === 'UserMessage') adoptPrompt(text)
              else adoptReport(text)
            }
          }
          break
        }
        case 'user_message': {
          // Observed on 0.146.0: `task_started` is written BEFORE `user_message`, so by
          // the time the prompt appears the turn usually already exists. Creating one
          // here unconditionally produced a phantom second turn per exchange.
          adoptPrompt(String(p.message ?? ''))
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
            // `task_complete` can carry an ERROR. Observed live as
            // `usage_limit_exceeded` -- the workspace was out of credits -- with
            // `last_agent_message: null`. The record says the turn completed because the
            // turn's machinery did; what it produced was a failure.
            //
            // Grading that `completed` made an errored turn indistinguishable from one that
            // legitimately said nothing, so the relay forwarded an empty message, the
            // implementer asked for a resend, and the run churned advisor turns toward its budget
            // instead of failing with the real reason. See issue #35.
            const err = p.error as { message?: string; codex_error_info?: string } | null | undefined
            if (err) {
              rec.state = 'unknown_abnormal_end'
              rec.confidence = 'proven'
              const info = err.codex_error_info ? `${err.codex_error_info}: ` : ''
              rec.provenance = [
                {
                  source: 'transcript',
                  detail: `${TASK_COMPLETE_ERROR}${info}${err.message ?? 'no message'}`,
                },
              ]
              // Deliberately no `report`. There is no assistant message, and inventing one
              // from the error text would put the vendor's words into the participant's
              // mouth and route them onward as though the advisor had said them.
              break
            }
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
          if (p.message) adoptReport(String(p.message))
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

  return { turns, declaredCompaction: compactions > 0, compactions, sessionId }
}

export function parserFor(agent: string): (r: Record<string, any>[]) => ParsedTranscript {
  if (agent === 'codex') return parseCodex
  if (agent === 'claude') return parseClaude
  throw new Error(`no transcript parser for agent ${agent}`)
}
