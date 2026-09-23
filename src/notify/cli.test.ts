/**
 * The `conclave notify` surface: what the operating agent calls to reach a human.
 *
 *   node --test src/notify/cli.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { CONFIG_RELATIVE } from '../config/project.ts'
import { tempDir } from '../testkit/tempDir.ts'
import { SessionRecorder } from '../workspace/sessionRecord.ts'
import { FAKE_REPLY_ENV, resolveTransport, transportNames } from './registry.ts'

const CLI = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')

/**
 * A project that has OPTED IN to notify (#374), which is what every test about notify's own
 * behaviour needs. The ones about the gate use `optedOut`, and say so.
 */
function repo(t: TestContext): string {
  const dir = optedOut(t)
  configure(dir, ENABLED)
  return dir
}

/** A project with no `.conclave/config.json` at all: notify has not been switched on. */
function optedOut(t: TestContext): string {
  const dir = tempDir(t, 'conclave-notify-cli')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

/** The opt-in, exactly as the refusal tells an operator to write it. */
const ENABLED = '{"notify":{"experimental":true}}'

/** A live run's record in `dir`, written by the real writer: what `--run` has to name (#278). */
function record(dir: string, id: string, goal: string): SessionRecorder {
  return new SessionRecorder(dir, {
    id,
    pid: process.pid,
    cwd: dir,
    goal,
    front: 'session',
    operator: 'agent',
    state: 'running',
    startedAt: 1_700_000_000_000,
    messages: 0,
    participants: [],
    build: 'test-build',
  })
}

/**
 * THE TWO STREAMS STAY APART (#317). These spawn `node <cli>` directly -- the developer
 * spelling, which #313 deliberately left warning -- and Node emits an `ExperimentalWarning`
 * about type stripping on stderr on some supported versions and not others. Concatenating the
 * streams put that warning in front of the JSON these tests parse, so four of them failed on
 * Node 24.0.2 and passed on 24.13: a version-dependent break in tests that are about neither
 * version nor stderr.
 *
 * `out` is stdout and answers "what did the command print"; `err` is stderr and is asserted
 * only where a test means it -- the broker announces its start there, deliberately. `said` is
 * both, for the assertions that do not care which stream carried the sentence.
 */
/**
 * stderr with Node's own warnings removed, for comparisons between two invocations.
 *
 * `(node:<pid>) ExperimentalWarning: Type Stripping` carries a PID, so it is never equal across
 * runs, and its follow-on `(Use \`node --trace-warnings ...\`)` comes with it. Neither is
 * conclave speaking. The shebang suppresses them in normal use; a test that spawns `node`
 * directly skips the shebang and sees them on whichever versions still emit the warning.
 */
function withoutHarnessNoise(err: string): string {
  return err
    .split('\n')
    .filter((l) => !/^\(node:\d+\) \w*Warning:/.test(l) && !/^\(Use `node --trace-warnings/.test(l))
    .join('\n')
}

function run(args: string[], cwd: string, reply?: string): { code: number; out: string; err: string; said: string } {
  // `--transport fake` is NAMED, not inherited (#351). It used to be the default, which is how
  // an agent operator following the skill reached a stub and learned there was no human channel
  // at the moment it needed one. These tests are about the fake transport, so saying so is the
  // honest spelling -- and a helper that silently supplied the default would be the only place
  // in the suite still relying on the behaviour that was removed.
  const named = args.some((a) => a === '--transport') || args[0] === 'log' || args[0] === 'broker'
  const r = spawnSync('node', [CLI, 'notify', ...args, ...(named ? [] : ['--transport', 'fake'])], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(reply === undefined ? {} : { [FAKE_REPLY_ENV]: reply }) },
  })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr, said: `${r.stdout}${r.stderr}` }
}

test('#184 a name that is not a transport says what the names are', (t) => {
  // A registry that answered only "not found" would give the same message for a typo and for
  // an adapter nobody has written yet.
  const r = run(['tell', 'x', '--transport', 'glasses'], repo(t))
  assert.equal(r.code, 2)
  assert.match(r.said, /no transport named glasses/)
  for (const n of transportNames()) assert.ok(r.said.includes(n), `it must list ${n}`)
})

test('#184 a tap comes back as an option, and speech comes back as text', (t) => {
  // The distinction the whole inbound design rests on. An action is an id that was offered; an
  // utterance is text the CALLER interprets, because the caller is the operating agent and has
  // the context. Nothing here parses English into a conclave command.
  const dir = repo(t)

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

test('#351 notify with no transport refuses instead of inheriting test plumbing', (t) => {
  // The default was `fake`. An agent operator that followed the skill to `notify ask` reached a
  // scripted stub, saw "fake carried no answer", and read it as a delivery failure -- so it
  // discovered there was no human channel at the moment it had a question it could not answer,
  // which for an unattended run is also the moment nobody is coming.
  const dir = repo(t)
  for (const args of [
    ['ask', 'Merge?', '--options', 'yes:Merge'],
    ['tell', 'run started'],
  ]) {
    const r = spawnSync('node', [CLI, 'notify', ...args], { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 2, `${args[0]} must refuse rather than pick one`)
    const said = `${r.stdout}${r.stderr}`
    assert.match(said, /notify needs --transport/)
    assert.match(said, /no human channel is configured by default/)
    // The names, so the refusal is actionable in the same breath -- the same rule the unknown
    // transport refusal already follows.
    for (const n of transportNames()) assert.ok(said.includes(n), `it must list ${n}`)
    // And it must say what `fake` is, because that is the one an agent would otherwise reach
    // for on seeing the list.
    assert.match(said, /test plumbing/)
  }

  // Named, it is still available: this is a removed DEFAULT, not a removed transport.
  const named = run(['tell', 'run started', '--transport', 'fake'], dir)
  assert.equal(named.code, 0, 'naming the stub is a choice the CLI honours')
})

/** `.conclave/config.json` in `dir`, written as the operator would write it. */
function configure(dir: string, json: string): void {
  mkdirSync(join(dir, '.conclave'), { recursive: true })
  writeFileSync(join(dir, CONFIG_RELATIVE), json)
}

/** `conclave notify <args>` exactly as typed: no `--transport` is supplied for the caller. */
function bare(args: string[], cwd: string): { code: number; out: string; err: string; said: string } {
  const r = spawnSync('node', [CLI, 'notify', ...args], { cwd, encoding: 'utf8' })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr, said: `${r.stdout}${r.stderr}` }
}

test('#353 a transport configured for the project is used when the call names none', (t) => {
  // The answer to #351's refusal, written down once. `fake` is what is configured here because
  // it is the transport a test can drive; that it is also the stub #351 stopped defaulting to is
  // the point of the second assertion -- configured, it is a choice, and the CLI honours it.
  const dir = repo(t)
  configure(dir, '{"notify":{"experimental":true,"transport":"fake"}}')
  const told = bare(['tell', 'run started'], dir)
  assert.equal(told.code, 0, told.said)
  assert.equal(told.out.trim(), '', 'a delivered notification says nothing')
  assert.doesNotMatch(told.said, /notify needs --transport/)
  const log = JSON.parse(run(['log', '--json'], dir).out) as { transport: string }[]
  assert.equal(log[0]?.transport, 'fake', 'and the record names the transport the file chose')
  // `vetoes` resolves its transport the same way.
  assert.equal(bare(['vetoes'], dir).code, 0)
})

test('#353 --transport on the call beats the configured one, in both directions', (t) => {
  // Precedence stated rather than assumed. Each direction is proved by a transport that would
  // have behaved differently: `even-realities` refuses without `--run`, `fake` needs nothing.
  const dir = repo(t)
  configure(dir, '{"notify":{"experimental":true,"transport":"even-realities"}}')
  const flagWins = bare(['tell', 'hi', '--transport', 'fake'], dir)
  assert.equal(flagWins.code, 0, flagWins.said)
  assert.doesNotMatch(flagWins.said, /even-realities needs the run/)

  configure(dir, '{"notify":{"experimental":true,"transport":"fake"}}')
  const flagStillWins = bare(['tell', 'hi', '--transport', 'even-realities'], dir)
  assert.equal(flagStillWins.code, 2)
  assert.match(flagStillWins.said, /even-realities needs the run it speaks for/)
})

test('#353 a configured name nothing resolves is refused when the file is read, with the names', (t) => {
  // Refused by the config reader, so the words are the reader's and the failure is at the first
  // command that reads the file -- not at the first `notify ask` of an unattended run.
  const dir = repo(t)
  configure(dir, '{"notify":{"experimental":true,"transport":"glasses"}}')
  for (const args of [['tell', 'hi'], ['tell', 'hi', '--transport', 'fake']]) {
    const r = bare(args, dir)
    assert.notEqual(r.code, 0, `${args.join(' ')} must not succeed on a file that names nothing`)
    assert.match(r.said, /config\.json: unknown transport 'glasses'\. Known: /)
    for (const n of transportNames()) assert.ok(r.said.includes(n), `it must list ${n}`)
    assert.doesNotMatch(r.said, /no transport named/, 'the file is refused as a file, not the name as a flag')
  }
})

test('#353 #374 enabled with no transport named refuses in #351 words, whatever else the file says', (t) => {
  // Byte for byte on both streams and the exit code. This is #351's refusal, and #353 added a
  // place to answer it, not a new sentence: the two runs differ only in whether the config file
  // says anything besides the opt-in, and a file that names no transport must not change a
  // character of it. Before #374 the first run had no file at all; with the gate, no file is
  // the opted-out refusal, which is pinned in its own test below.
  const withoutFile = bare(['ask', 'Merge?', '--options', 'yes:Merge'], repo(t))
  const dir = repo(t)
  configure(dir, '{"permissions":"ask","notify":{"experimental":true}}')
  const withFile = bare(['ask', 'Merge?', '--options', 'yes:Merge'], dir)
  assert.equal(withoutFile.code, 2)
  assert.equal(withFile.code, withoutFile.code)
  assert.equal(withFile.out, withoutFile.out)
  // WITHOUT THE HARNESS'S OWN NOISE. Node prints `(node:<pid>) ExperimentalWarning: Type
  // Stripping` when it runs this source directly, and the PID in it differs between two runs --
  // so comparing raw stderr asserts that two processes had the same pid, which they never do.
  // It passed everywhere the warning does not fire and failed on the Node floor, where it does:
  // a test that could only hold on the platforms that happened not to produce the line.
  assert.equal(withoutHarnessNoise(withFile.err), withoutHarnessNoise(withoutFile.err))
  // And the sentence itself is pinned, so the identity above cannot be two copies of a new one.
  const refusal =
    `conclave: notify needs --transport — no human channel is configured by default\n` +
    `  have: ${transportNames().join(', ')}\n` +
    `  \`fake\` is test plumbing and answers nothing; naming it is a choice, not a fallback\n`
  assert.ok(withFile.err.includes(refusal), `stderr must carry the #351 refusal verbatim:\n${withFile.err}`)
  assert.equal(withFile.out, '')
  // Enabled, so the opt-in refusal is not what speaks: the two are different sentences for
  // different repairs, and the no-transport one must not be reached through the gate's words.
  assert.doesNotMatch(withFile.err, /EXPERIMENTAL/)
})

/** The #374 refusal, verbatim: what an opted-out project hears from `tell` and `ask`. */
const NOT_ENABLED =
  `conclave: notify is EXPERIMENTAL and is not enabled in this project\n` +
  `  enable it in .conclave/config.json: {"notify":{"experimental":true}}\n` +
  `  one transport reaches a person, over a protocol conclave does not own; \`conclave notify broker status\` works without this\n`

test('#374 no file, an empty notify block and experimental:false are the same opted-out project', (t) => {
  // Three spellings of "not switched on", and a transport configured WITHOUT the opt-in, which
  // is the one most likely to be written by someone who read #353 and not #374. All refuse
  // identically, and before the transport is resolved: a named transport on the call, or in the
  // file, does not get past the gate.
  const spellings: (string | undefined)[] = [
    undefined,
    '{}',
    '{"notify":{}}',
    '{"notify":{"experimental":false}}',
    '{"notify":{"transport":"fake"}}',
  ]
  for (const args of [
    ['tell', 'run started'],
    ['ask', 'Merge?', '--options', 'yes:Merge'],
    ['tell', 'run started', '--transport', 'fake'],
    ['ask', 'Merge?', '--transport', 'even-realities'],
  ]) {
    const heard = spellings.map((json) => {
      const dir = optedOut(t)
      if (json !== undefined) configure(dir, json)
      const r = bare(args, dir)
      return { json, code: r.code, out: r.out, err: withoutHarnessNoise(r.err) }
    })
    for (const h of heard) {
      const where = `${args.join(' ')} with ${h.json ?? 'no config file'}`
      assert.equal(h.code, 2, where)
      assert.equal(h.out, '', where)
      assert.equal(h.err, NOT_ENABLED, `${where}: the refusal, and nothing else`)
    }
  }
})

test('#374 the opt-in refusal and the no-transport refusal are different sentences', (t) => {
  // An opt-in that failed as "no transport" would send an operator to name one, and they would
  // hit the gate again: the repair has to be in the refusal that actually fired.
  const off = bare(['tell', 'hi'], optedOut(t))
  const on = bare(['tell', 'hi'], repo(t))
  assert.equal(off.code, 2)
  assert.equal(on.code, 2)
  assert.match(off.err, /notify is EXPERIMENTAL and is not enabled in this project/)
  assert.doesNotMatch(off.err, /notify needs --transport/)
  assert.match(on.err, /notify needs --transport/)
  assert.doesNotMatch(on.err, /not enabled in this project/)
})

test('#374 the design records why the gate exists, where it stops, and why its refusal is its own', () => {
  // The rationale is what keeps the next change honest: widen the gate to `broker` and the
  // diagnostic surface refuses; fold its refusal into "no transport" and #351 is rebuilt. One
  // assertion per load-bearing clause, each written as the section states it.
  const design = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'DESIGN.md'), 'utf8')
  const at = design.indexOf('### Notify is experimental and opt-in')
  assert.ok(at >= 0, 'the section must exist')
  assert.ok(at < design.indexOf('### One device, many runs'), 'and sit before the broker section it motivates')
  const flat = design.slice(at, design.indexOf('### One device, many runs')).replace(/\s+/g, ' ')
  assert.match(flat, /#351 made the choice of transport honest/)
  assert.match(flat, /#353 made that choice configurable/)
  assert.match(flat, /But neither makes the channel dependable/)
  assert.match(flat, /a protocol owned by a third-party app that can change without notice/)
  assert.match(flat, /The gate covers `tell` and `ask` only, because they are the verbs that reach a person/)
  assert.match(flat, /a different sentence from the one an opted-in project with no transport gets/)
  assert.match(flat, /`broker`, `log` and `vetoes` stay ungated because they are diagnostics and history/)
})

test('#374 broker, log and vetoes answer in a project that has not opted in', (t) => {
  // The diagnostic surface. Someone working out why notify will not work needs `broker status`
  // to answer rather than refuse, and a project that opted out after using notify still has its
  // record and any late answers to account for.
  const dir = optedOut(t)
  const env = { ...process.env, CONCLAVE_EVEN_SOCKET: join(dir, 'even.sock') }
  const status = spawnSync('node', [CLI, 'notify', 'broker', 'status'], { cwd: dir, encoding: 'utf8', env })
  assert.equal(status.status, 1, 'no broker is running, which is an answer rather than a refusal')
  assert.match(status.stdout, /no Even Realities broker at /)
  const stop = spawnSync('node', [CLI, 'notify', 'broker', 'stop'], { cwd: dir, encoding: 'utf8', env })
  assert.equal(stop.status, 0)
  const log = bare(['log'], dir)
  assert.equal(log.code, 0)
  assert.match(log.out, /no decisions recorded/)
  const vetoes = bare(['vetoes', '--transport', 'fake'], dir)
  assert.equal(vetoes.code, 0, vetoes.said)
  for (const r of [status, stop]) assert.doesNotMatch(`${r.stdout}${r.stderr}`, /EXPERIMENTAL/)
  for (const r of [log, vetoes]) assert.doesNotMatch(r.said, /EXPERIMENTAL/)
})

test('#353 the top-level help says the transport can be configured, and which of flag and file wins', (t) => {
  // `conclave --help` is what an agent reads before the skill, and it used to say `--transport`
  // is REQUIRED -- true at the refusal, false as a description of the surface once the file can
  // name one. The runtime refusal is deliberately unchanged, so the help is where this is said.
  const r = spawnSync('node', [CLI, '--help'], { cwd: repo(t), encoding: 'utf8' })
  assert.equal(r.status, 0)
  const help = r.stdout.replace(/\s+/g, ' ')
  assert.doesNotMatch(help, /--transport is REQUIRED/)
  assert.match(help, /\.conclave\/config\.json names one for the project \(\{"notify":\{"transport":"<name>"\}\}\)/)
  assert.match(help, /the flag wins over the file, and with neither, notify refuses and lists the names/)
  assert.match(help, /It may still be named, on the call or in the file, as a choice/, 'a configured `fake` is a choice, and the help says so')
  assert.match(help, /port, host and token stay environment variables: they describe the machine, not the project/)
})

test('#374 the top-level help says notify is experimental, how to opt in, and that the two refusals differ', (t) => {
  // An agent reads `--help` before it reads the skill, so this is the earliest place the opt-in
  // can be learned. The JSON must be the exact thing to write, and the refusal quoted must be
  // the one the gate actually prints.
  const r = spawnSync('node', [CLI, '--help'], { cwd: repo(t), encoding: 'utf8' })
  assert.equal(r.status, 0)
  const help = r.stdout.replace(/\s+/g, ' ')
  assert.match(help, /EXPERIMENTAL, and off unless the project opts in with \{"notify":\{"experimental":true\}\} in \.conclave\/config\.json/)
  assert.ok(help.includes('"notify is EXPERIMENTAL and is not enabled in this project"'), 'the refusal, quoted as the gate prints it')
  assert.ok(NOT_ENABLED.startsWith('conclave: notify is EXPERIMENTAL and is not enabled in this project\n'), 'and that is the sentence the gate prints')
  assert.match(help, /broker, log and vetoes answer either way/)
  assert.match(help, /IF a transport is named, and by default none is; that is a different refusal/)
  assert.match(help, /a third-party app owns and may change without notice/)
  assert.doesNotMatch(help, /only channel/)
})

test('#184 a question that carried no answer exits non-zero', (t) => {
  // The caller asked and did not get an answer. The decision it was asking about has not gone
  // away, so success would be a lie an unattended caller acts on.
  const r = run(['ask', 'Merge?', '--options', 'yes:Merge'], repo(t))
  assert.equal(r.code, 1)
  // And it says WHY, which for the stub is not a delivery failure (#351): "carried no answer"
  // alone sent an operator to `notify log` and the broker before they read the source.
  assert.match(r.said, /fake is test plumbing and answers nothing/)
  assert.match(r.said, /no human was asked/)
  assert.doesNotMatch(r.said, /carried no answer/, 'a stub answering nothing is not a transport failing')
})

test('#184 a tell never waits, says nothing, and is not recorded as unanswered', (t) => {
  // Silent on success by design: a notification that printed would become output the caller has
  // to read, and the caller is an agent with a transcript to spend.
  const dir = repo(t)
  const told = run(['tell', 'run started'], dir)
  assert.equal(told.code, 0)
  assert.equal(told.out.trim(), '', 'a delivered notification says nothing')

  const log = run(['log'], dir)
  assert.match(log.said, /delivered/, 'and the log calls it delivered')
  assert.doesNotMatch(log.said, /unanswered/, 'nothing asked it anything, so it is not unanswered')
})

test('#184 the log distinguishes answered, unanswered and undelivered', (t) => {
  const dir = repo(t)
  run(['ask', 'Answered?', '--options', 'y:Yes'], dir, '{"option":"y","from":{"id":"mic","kind":"human"}}')
  run(['ask', 'Unanswered?', '--options', 'y:Yes'], dir)

  const json = JSON.parse(run(['log', '--json'], dir).out) as { headline: string; answer?: unknown; undelivered?: string }[]
  assert.equal(json.length, 2)
  assert.ok(json[0]?.answer, 'the answered one carries its answer')
  assert.match(json[1]?.undelivered ?? '', /no reply configured/, 'the other says why not')
})

test('#184 a malformed scripted reply produces no answer rather than an invented one', (t) => {
  // An answer nobody gave is the one output this must never produce.
  const r = run(['ask', 'Merge?', '--options', 'y:Yes'], repo(t), 'not json at all')
  assert.equal(r.code, 1)
  assert.match(r.said, /answers nothing|carried no answer/, 'no answer, however the reply was malformed')
})

test('#184 the fake transport is resolvable by name, and is the reference adapter', () => {
  const t = resolveTransport('fake')
  assert.ok(t, 'fake must resolve')
  assert.equal(t.name, 'fake')
  assert.equal(t.limits.canReceive, true)
  assert.equal(resolveTransport('nope'), undefined)
})

/** A port nothing is on, chosen by the OS and released, so the CLI can bind it a moment later. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address()
      const port = a !== null && typeof a === 'object' ? a.port : 0
      srv.close(() => resolve(port))
    })
  })
}

test('#278 --run is the session the glasses see, and the friendly name is only its title', async (t) => {
  // End to end through the real transport: the app lists sessions, opens the one whose `id` it
  // read, and answers under that id. Before #278 the list had one hardcoded entry keyed
  // `sessionId`, which the app never read, and any answer at all settled the one question.
  // The stop hook first: `after` hooks run in the order added, and the directory's own cleanup
  // must not remove the socket before the broker behind it has been told to stop.
  let stop: (() => void) | undefined
  t.after(() => stop?.())
  const dir = repo(t)
  const rec = record(dir, 'run-278', 'g'.repeat(100))
  rec.event({ type: 'message', at: 1_700_000_050_000 } as never)
  const port = await freePort()
  // THE RUN DOES NOT BIND THE PORT (#286): its first send starts the broker, a process of its
  // own, and speaks to it over this socket. Pointed at the test's directory so no per-user
  // broker is touched, and stopped after, whatever happened.
  const env = {
    ...process.env,
    CONCLAVE_EVEN_PORT: String(port),
    CONCLAVE_EVEN_TOKEN: 'tok',
    CONCLAVE_EVEN_QUIET: '1',
    CONCLAVE_EVEN_SOCKET: join(dir, 'even.sock'),
    CONCLAVE_NOTIFY_NAME: 'glasses-name',
  }
  stop = () => spawnSync('node', [CLI, 'notify', 'broker', 'stop'], { cwd: dir, env })
  const child = spawn(
    'node',
    [CLI, 'notify', 'ask', 'Merge?', '--options', 'yes:Merge,no:Hold', '--transport', 'even-realities', '--run', 'run-278'],
    { cwd: dir, env },
  )
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => (out += String(c)))
  child.stderr.on('data', (c) => (err += String(c)))
  const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)))
  t.after(() => child.kill())

  const base = `http://127.0.0.1:${port}`
  // The broker comes up when `ask` sends, and the run's session lands a moment after its
  // port answers; poll the list the app polls until the run is on it. Waited on either way --
  // a refused connection or an empty list -- because under the broker those are two windows,
  // not one, and a loop that only slept on the first spun through the second in a blink.
  let sessions: Record<string, unknown>[] = []
  // A liveness ceiling, not a speed claim: the loop waits on a state, and the deadline only
  // turns "never" into a failure. Generous because a loaded runner has taken seconds to get
  // here where a quiet one takes milliseconds, and a ceiling that fires there reports a
  // timing fault the code does not have (#294).
  const deadline = Date.now() + 20_000
  // WAIT FOR THE STATE, NOT THE ENTRY. The session is listed the moment it opens, and only
  // reads `awaiting` once the question is actually outstanding -- two events, with a window
  // between them that a loaded runner opens wide enough to see. Waiting on the entry alone
  // asserted into that window and failed on CI with `status: null`.
  const settled = (): boolean => sessions.length > 0 && sessions[0]!['status'] === 'awaiting'
  while (!settled() && Date.now() < deadline) {
    try {
      sessions = ((await (await fetch(`${base}/api/sessions?token=tok`)).json()) as { sessions: typeof sessions }).sessions
    } catch {
      // Not up yet.
    }
    if (!settled()) await new Promise((r) => setTimeout(r, 50))
  }
  // The run id is the session, and the rest of the item is the run's record: the goal as the
  // title, cut to the vendor's 64; the newest event as the timestamp; the working directory.
  assert.deepEqual(sessions, [
    {
      id: 'run-278',
      title: 'g'.repeat(64),
      timestamp: new Date(1_700_000_050_000).toISOString(),
      cwd: dir,
      provider: 'claude',
      status: 'awaiting',
    },
  ])
  assert.equal(JSON.stringify(sessions).includes('glasses-name'), false, 'the name is a label on messages, not the session')

  // The name is NOT an id. An answer routed by it is refused, and settles nothing.
  const byName = await fetch(`${base}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'glasses-name', answer: 'Merge' }),
  })
  assert.equal(byName.status, 404)

  const byRun = await fetch(`${base}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'run-278', answer: 'Merge' }),
  })
  assert.equal(byRun.status, 200)
  assert.equal(await exited, 0, err)
  assert.deepEqual(JSON.parse(out), { option: 'yes', text: 'Merge', by: { id: 'even-realities', kind: 'human' } })
  // The start was announced, on stderr, by the run that did it -- with what it started.
  assert.match(err, /started the Even Realities broker \(pid \d+\)/)
  assert.match(err, /conclave notify broker stop/)

  const log = JSON.parse(run(['log', '--json'], dir).out) as { runId?: string; transport: string }[]
  assert.equal(log[0]?.runId, 'run-278', 'and the record names the same run')
  assert.equal(log[0]?.transport, 'even-realities')
})

test('#278 even-realities without a run is refused with exit 2, and other transports are not', (t) => {
  // A session on the glasses is a run. Nothing is minted to stand in for one: a session the
  // app could open that `conclave sessions` could not find would be an id nobody can act on.
  const dir = repo(t)
  const env = { CONCLAVE_EVEN_PORT: '0', CONCLAVE_EVEN_TOKEN: 'tok', CONCLAVE_EVEN_QUIET: '1' }
  const refused = (args: string[]): { code: number; out: string; err: string; said: string } => {
    const r = spawnSync('node', [CLI, 'notify', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } })
    // Separate streams, for the reason the top-level `run` gives (#317).
    return { code: r.status ?? -1, out: r.stdout, err: r.stderr, said: `${r.stdout}${r.stderr}` }
  }
  for (const args of [
    ['tell', 'hi', '--transport', 'even-realities'],
    ['ask', 'go?', '--options', 'y:Yes', '--transport', 'even-realities'],
    ['vetoes', '--transport', 'even-realities'],
    ['tell', 'hi', '--transport', 'even-realities', '--run', ''],
  ]) {
    const r = refused(args)
    assert.equal(r.code, 2, `${args.join(' ')}: exit 2`)
    assert.match(r.said, /even-realities needs the run it speaks for: pass --run <id>/, args.join(' '))
    assert.doesNotMatch(r.said, /no transport named/, 'a transport that exists is not reported as missing')
  }
  // A run this project has no record of is refused too, in words that say where to look.
  const unknown = refused(['tell', 'hi', '--transport', 'even-realities', '--run', 'nope'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.said, /no readable record for run nope in this project — see conclave sessions/)
  // The same commands on `fake` need no run and are unchanged.
  assert.equal(refused(['tell', 'hi', '--transport', 'fake']).code, 0)
  assert.equal(refused(['vetoes', '--transport', 'fake']).code, 0)
  assert.equal(run(['log'], dir).out.includes('hi'), true, 'and the fake tell was recorded')
})
