/**
 * Every job in every workflow declares `timeout-minutes` (#404).
 *
 * Without one a job inherits GitHub's 360-minute default. A job that hangs then burns six hours
 * and ends `cancelled`, which is neither a pass nor a failure, so the run cannot answer "is main
 * green". That happened on e977053. The timeouts themselves sit in the workflows with their
 * evidence; this test is the durable half, because the failure it guards is SILENT: a job added
 * later without a timeout simply inherits 360 minutes, and nobody learns until it hangs.
 *
 * No exceptions, so there is no exception list to rot.
 *
 * ## Why a line parser, and not YAML
 *
 * This repository has no YAML parser and deliberately does not take one (#389 argues the same
 * trade for TOML), and this test must not shell out either. It needs to answer one narrow
 * question -- does each job block carry the key AT JOB LEVEL -- not to understand YAML. So it
 * reads lines, the way `citations.ts` does, and refuses anything it does not recognise.
 *
 * ## What the parser handles
 *
 * Exactly the shape this repository's workflows are written in, and nothing it would have to
 * infer: a top-level `jobs:` line at column 0 with nothing after it but a comment; job keys as
 * plain `name:` lines at exactly 2 spaces; each job's properties at exactly 4 spaces, starting on
 * the line after the key. Anything deeper than 4 belongs to some property and is not read. Blank
 * lines and whole-line comments are skipped anywhere. A job is covered when a `timeout-minutes:`
 * key appears at exactly 4 spaces inside it. Its VALUE is not checked -- GitHub validates that,
 * and a parser here that judged values would reject the next valid expression and grow into a
 * partial YAML parser. The key on a STEP (which bounds the step, not the job) or inside a
 * `run: |` script never counts, because both necessarily sit deeper than 4.
 *
 * ## What it does NOT handle, and fails on instead
 *
 * Each of these makes the file's scan an ERROR naming the file and line, never a pass:
 *   - no `jobs:` line at column 0, or `jobs:` with an inline value (flow style `{ ... }`);
 *   - a `jobs:` block with no job keys in it;
 *   - any line in the jobs block at an indent other than 2 or 4 that is not inside a property
 *     -- INCLUDING the first job, so a file indented 4/6 throughout, which is valid YAML, is
 *     refused rather than read as having no jobs or no timeouts;
 *   - a line at 2 that is not a plain `name:` key (a quoted key, an inline mapping
 *     `build: { ... }`, an anchor `build: &x`);
 *   - a tab in leading whitespace;
 *   - a job with no properties at all.
 * A timeout supplied through an alias or merge key (`<<: *defaults`) is not followed: that job
 * is reported as MISSING, which is the safe direction for this test to be wrong in. A multi-line
 * flow or quoted scalar at job level whose continuation line starts at exactly 4 spaces with
 * `timeout-minutes:` would be misread as the key; no workflow here has such a thing, and the
 * shape is contrived enough that it is named rather than guarded.
 *
 * "I could not find the jobs" is never allowed to read as "no job lacks a timeout": that is the
 * vacuous-pass shape `ABSENT_LITERAL_CANARY` in `src/registry/installedBundle.ts` exists for.
 * Here the same guard is that a file with zero recognised jobs is an error, and the directory
 * scan fails if it finds no workflow files at all.
 */

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const REPO = join(import.meta.dirname, '..', '..')
const WORKFLOWS = join(REPO, '.github', 'workflows')
const FIXTURES = join(import.meta.dirname, 'fixtures', 'workflowTimeouts')

interface Job {
  name: string
  /** 1-based line of the job key. */
  line: number
  /** 1-based line of the job-level `timeout-minutes:`, if there is one. */
  timeoutLine?: number
}

type Scan = { ok: true; jobs: Job[] } | { ok: false; line: number; reason: string }

/** The one shape understood. Fixed, not inferred: an inferred indent is a guess. */
const JOB_INDENT = 2
const PROP_INDENT = 4

const indentOf = (s: string) => s.length - s.trimStart().length
const skippable = (s: string) => s.trim() === '' || s.trimStart().startsWith('#')

const JOB_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(#.*)?$/

/** Finds the jobs in one workflow file, or says exactly where it gave up. */
function scanWorkflow(text: string): Scan {
  const lines = text.split('\n')
  const fail = (i: number, reason: string): Scan => ({ ok: false, line: i + 1, reason })

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (skippable(l)) continue
    if (/^[ \t]*\t/.test(l)) return fail(i, 'tab in indentation')
  }

  const start = lines.findIndex(l => /^jobs:/.test(l))
  if (start === -1) return fail(0, 'no top-level `jobs:` line')
  if (!/^jobs:\s*(#.*)?$/.test(lines[start]!)) {
    return fail(start, '`jobs:` has an inline value (flow style?); only block style is understood')
  }

  const jobs: Job[] = []
  let current: Job | undefined
  let hasProps = false
  const noProps = (j: Job) => fail(j.line - 1, `job "${j.name}" has no properties`)

  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (skippable(l)) continue
    const ind = indentOf(l)
    if (ind === 0) break // the next top-level key ends the jobs block
    const body = l.trimStart()

    if (ind === JOB_INDENT) {
      const m = JOB_KEY.exec(body)
      if (!m) return fail(i, `expected a plain \`name:\` job key at indent ${JOB_INDENT}, got: ${body}`)
      if (current && !hasProps) return noProps(current)
      current = { name: m[1]!, line: i + 1 }
      jobs.push(current)
      hasProps = false
    } else if (ind === PROP_INDENT && current) {
      hasProps = true
      if (body.startsWith('timeout-minutes:')) current.timeoutLine = i + 1
    } else if (ind > PROP_INDENT && hasProps) {
      // Inside some property's value: a matrix, a step, a script. Not read.
    } else {
      return fail(i, `indent ${ind} where only a job key (${JOB_INDENT}) or a job property (${PROP_INDENT}) is understood`)
    }
  }

  if (current && !hasProps) return noProps(current)
  if (jobs.length === 0) return fail(start, '`jobs:` block has no job keys')
  return { ok: true, jobs }
}

/** One message per problem across a directory of workflows; empty means every job is covered. */
function problemsIn(dir: string): { problems: string[]; jobsSeen: number } {
  const files = readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort()
  if (files.length === 0) return { problems: [`${dir}: no workflow files found, so nothing was checked`], jobsSeen: 0 }
  const problems: string[] = []
  let jobsSeen = 0
  for (const f of files) {
    const scan = scanWorkflow(readFileSync(join(dir, f), 'utf8'))
    if (!scan.ok) {
      problems.push(`${f}:${scan.line}: could not read its jobs, so could not check them -- ${scan.reason}`)
      continue
    }
    jobsSeen += scan.jobs.length
    for (const j of scan.jobs) {
      if (j.timeoutLine === undefined) {
        problems.push(`${f}:${j.line}: job "${j.name}" declares no job-level timeout-minutes, so it inherits GitHub's 360`)
      }
    }
  }
  return { problems, jobsSeen }
}

test('#404 every job in every workflow declares a job-level timeout-minutes', () => {
  const { problems, jobsSeen } = problemsIn(WORKFLOWS)
  assert.deepEqual(problems, [])
  // Non-vacuous: the scan found jobs to check. The four that exist today are the floor, not a
  // pin -- adding a job must not break this line, only removing its timeout should.
  assert.ok(jobsSeen >= 4, `expected at least 4 jobs across the workflows, saw ${jobsSeen}`)
})

test('#404 control: a workflow where every job declares one passes', () => {
  const { problems, jobsSeen } = problemsIn(join(FIXTURES, 'covered'))
  assert.deepEqual(problems, [])
  assert.equal(jobsSeen, 2)
})

test('#404 a missing timeout names the job and the file; one on a step does not count', () => {
  const { problems } = problemsIn(join(FIXTURES, 'missing'))
  assert.deepEqual(problems, [
    `one-missing.yml:11: job "hangs" declares no job-level timeout-minutes, so it inherits GitHub's 360`,
  ])
})

test('#404 a workflow it cannot parse fails loudly rather than passing vacuously', () => {
  const { problems, jobsSeen } = problemsIn(join(FIXTURES, 'unparseable'))
  // Both fixtures are valid YAML in which every job has a timeout. Neither may pass.
  assert.equal(jobsSeen, 0)
  assert.equal(problems.length, 2)
  assert.match(problems[0]!, /^flow-jobs\.yml:5: could not read its jobs/)
  assert.match(problems[1]!, /^indented-4-6\.yml:7: could not read its jobs.* indent 4 where only/)
})

test('#404 the timeout VALUE is not judged; GitHub validates that', () => {
  const scan = scanWorkflow('jobs:\n  a:\n    timeout-minutes: ${{ inputs.anything }}\n  b:\n    timeout-minutes: soon\n')
  assert.ok(scan.ok)
  assert.deepEqual(scan.jobs.map(j => j.timeoutLine), [3, 5])
})

test('#404 shapes the parser does not understand are errors, not passes', () => {
  const wf = (jobs: string) => `name: x\non: push\njobs:\n${jobs}`
  const cases: Array<[string, string, RegExp]> = [
    ['no jobs key', 'name: x\non: push\n', /no top-level `jobs:`/],
    ['empty jobs block', 'name: x\njobs:\n# nothing\n', /no job keys/],
    ['inline-mapping job', wf('  build: { runs-on: x }\n'), /plain `name:` job key/],
    ['quoted job key', wf('  "build":\n    timeout-minutes: 5\n'), /plain `name:` job key/],
    ['first job key at 4', wf('    a:\n      timeout-minutes: 5\n'), /indent 4 where only/],
    ['property at 3', wf('  a:\n   timeout-minutes: 5\n'), /indent 3 where only/],
    ['first property deeper than 4', wf('  a:\n      timeout-minutes: 5\n'), /indent 6 where only/],
    ['job with no properties', wf('  a:\n  b:\n    timeout-minutes: 5\n'), /"a" has no properties/],
    ['last job with no properties', wf('  a:\n    timeout-minutes: 5\n  b:\n'), /"b" has no properties/],
    ['tab indentation', wf('\ta:\n\t\ttimeout-minutes: 5\n'), /tab in indentation/],
  ]
  for (const [label, text, reason] of cases) {
    const scan = scanWorkflow(text)
    assert.equal(scan.ok, false, `${label}: must not parse`)
    if (!scan.ok) assert.match(scan.reason, reason, label)
  }
})
