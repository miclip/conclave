/**
 * The agent-CLI version, taken from the transcript rather than from the binary (#246).
 *
 * A turn's verdict is a claim about what a CLI did, read out of that CLI's own record. When a
 * record shape later turns out to have changed — `parseCodex` recovered prompts on 4 of 71 turns
 * before #242 — "which runs were affected" is only answerable if the run said which version
 * wrote it.
 *
 * WHY NOT PROBE `<agent> --version`. That was built first and reverted. It executes the
 * operator's configured command, which conclave supports being a WRAPPER, so a run that should
 * invoke it once invoked it twice — caught by `executables.test.ts`, which pins exactly that. It
 * also answers about whatever is installed at the moment of asking rather than about what wrote
 * the evidence, and those differ: Claude Code updates itself between resumes.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { parseClaude, parseCodex } from './parse.ts'

const claudeRecord = (version: string, content: string) => ({
  type: 'user',
  version,
  message: { role: 'user', content },
})

test('#246 a Claude transcript reports every version that wrote it, in order', () => {
  // THE REASON THIS IS A LIST. Claude Code stamps `version` on every record and updates between
  // resumes; a real session file here carried six across 29,654 records. Reporting the newest
  // would name one binary for evidence produced by several — the error this field exists to
  // prevent, not to commit.
  const { cliVersions } = parseClaude([
    claudeRecord('2.1.227', 'first prompt'),
    claudeRecord('2.1.227', 'second prompt'),
    claudeRecord('2.1.259', 'after an upgrade'),
  ])
  assert.deepEqual(cliVersions, ['2.1.227', '2.1.259'], 'distinct, in order of first appearance')
})

test('#246 a Codex rollout reports the version from session_meta', () => {
  const { cliVersions } = parseCodex([
    { type: 'session_meta', payload: { session_id: 's1', cli_version: '0.153.4' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
  ])
  assert.deepEqual(cliVersions, ['0.153.4'])
})

test('#246 a transcript that carries no version says nothing, rather than empty', () => {
  // Absent and empty are different facts: "the format does not record it" is not "it recorded
  // none". The field is spread away rather than defaulted for that reason.
  assert.equal(parseClaude([{ type: 'user', message: { role: 'user', content: 'x' } }]).cliVersions, undefined)
  assert.equal(parseCodex([{ type: 'session_meta', payload: { session_id: 's1' } }]).cliVersions, undefined)
})

test('#246 a blank or non-string version is not recorded as one', () => {
  // Defensive because this reads another program's file: an empty string would become a version
  // nobody can look up, and the whole value of the field is that it names a real binary.
  const { cliVersions } = parseClaude([
    claudeRecord('', 'blank'),
    { type: 'user', version: 42, message: { role: 'user', content: 'number' } },
    claudeRecord('2.1.263', 'real'),
  ])
  assert.deepEqual(cliVersions, ['2.1.263'])
})
