/**
 * The `conclave notify` surface: what the operating agent calls to reach a human.
 *
 *   node --test src/notify/cli.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FAKE_REPLY_ENV, resolveTransport, transportNames } from './registry.ts'

const CLI = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'conclave-notify-cli-')))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

function run(args: string[], cwd: string, reply?: string): { code: number; out: string } {
  const r = spawnSync('node', [CLI, 'notify', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(reply === undefined ? {} : { [FAKE_REPLY_ENV]: reply }) },
  })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

test('#184 a name that is not a transport says what the names are', () => {
  // A registry that answered only "not found" would give the same message for a typo and for
  // an adapter nobody has written yet.
  const r = run(['tell', 'x', '--transport', 'glasses'], repo())
  assert.equal(r.code, 2)
  assert.match(r.out, /no transport named glasses/)
  for (const n of transportNames()) assert.ok(r.out.includes(n), `it must list ${n}`)
})

test('#184 a tap comes back as an option, and speech comes back as text', () => {
  // The distinction the whole inbound design rests on. An action is an id that was offered; an
  // utterance is text the CALLER interprets, because the caller is the operating agent and has
  // the context. Nothing here parses English into a conclave command.
  const dir = repo()

  const tapped = run(
    ['ask', 'Merge?', '--options', 'yes:Merge,no:Hold'],
    dir,
    '{"option":"yes","from":{"id":"mic","kind":"human"}}',
  )
  assert.equal(tapped.code, 0)
  assert.deepEqual(JSON.parse(tapped.out), { option: 'yes', by: { id: 'mic', kind: 'human' } })

  const spoken = run(
    ['ask', 'Merge?', '--options', 'yes:Merge'],
    dir,
    '{"text":"hold off until the advisor finishes","from":{"id":"mic","kind":"human"}}',
  )
  assert.equal(spoken.code, 0)
  const answer = JSON.parse(spoken.out) as { option?: string; text?: string }
  assert.equal(answer.option, undefined, 'speech must not become an action')
  assert.equal(answer.text, 'hold off until the advisor finishes')
})

test('#184 a question that carried no answer exits non-zero', () => {
  // The caller asked and did not get an answer. The decision it was asking about has not gone
  // away, so success would be a lie an unattended caller acts on.
  const r = run(['ask', 'Merge?', '--options', 'yes:Merge'], repo())
  assert.equal(r.code, 1)
  assert.match(r.out, /carried no answer/)
})

test('#184 a tell never waits, says nothing, and is not recorded as unanswered', () => {
  // Silent on success by design: a notification that printed would become output the caller has
  // to read, and the caller is an agent with a transcript to spend.
  const dir = repo()
  const told = run(['tell', 'run started'], dir)
  assert.equal(told.code, 0)
  assert.equal(told.out.trim(), '', 'a delivered notification says nothing')

  const log = run(['log'], dir)
  assert.match(log.out, /delivered/, 'and the log calls it delivered')
  assert.doesNotMatch(log.out, /unanswered/, 'nothing asked it anything, so it is not unanswered')
})

test('#184 the log distinguishes answered, unanswered and undelivered', () => {
  const dir = repo()
  run(['ask', 'Answered?', '--options', 'y:Yes'], dir, '{"option":"y","from":{"id":"mic","kind":"human"}}')
  run(['ask', 'Unanswered?', '--options', 'y:Yes'], dir)

  const json = JSON.parse(run(['log', '--json'], dir).out) as { headline: string; answer?: unknown; undelivered?: string }[]
  assert.equal(json.length, 2)
  assert.ok(json[0]?.answer, 'the answered one carries its answer')
  assert.match(json[1]?.undelivered ?? '', /no reply configured/, 'the other says why not')
})

test('#184 a malformed scripted reply produces no answer rather than an invented one', () => {
  // An answer nobody gave is the one output this must never produce.
  const r = run(['ask', 'Merge?', '--options', 'y:Yes'], repo(), 'not json at all')
  assert.equal(r.code, 1)
  assert.match(r.out, /carried no answer/)
})

test('#184 the fake transport is resolvable by name, and is the reference adapter', () => {
  const t = resolveTransport('fake')
  assert.ok(t, 'fake must resolve')
  assert.equal(t.name, 'fake')
  assert.equal(t.limits.canReceive, true)
  assert.equal(resolveTransport('nope'), undefined)
})
