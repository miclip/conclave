/**
 * Checking a goal before two agents are spawned against it.
 *
 * When an agent operator drives Conclave it writes the goal, so the goal stops being a human
 * intention expressed in prose and becomes a generated artefact — one that can be checked
 * while checking is still free. After this point every problem with it is paid for in
 * participant turns.
 *
 * The failure mode is specific: an agent-authored goal tends to be fluent, plausible and
 * unfalsifiable. It reads well and gives the participants no way to know when they are done.
 * Conclave then grades the outcome `reasoned_but_unverified` and nobody can say whether that
 * is the participants' fault or the goal's.
 *
 * ## What this is not
 *
 * It is a LINT, not a judgement. Every rule here is a keyword heuristic over English prose and
 * every one of them can be wrong in both directions. That is why the default is a warning and
 * `--strict-goal` is opt-in: a bad goal is sometimes a deliberate probe, and a check that
 * blocks work becomes a check people route around.
 *
 * The rules are also deliberately few. A long list of weak signals produces a warning on every
 * goal, which trains the reader to skip the exact place a real problem appears — the same
 * reasoning that keeps `SessionEnd` at a 3s timeout in the hook templates rather than eating a
 * warning on every invocation.
 */

export type GoalFindingCode =
  | 'no_acceptance_criteria'
  | 'unobservable_completion'
  | 'multiple_goals'
  | 'asserted_premise'

export interface GoalFinding {
  code: GoalFindingCode
  message: string
  /** Why it matters HERE, in terms of what Conclave will do with the goal. */
  consequence: string
}

/** Words that name something a machine could run or compare. */
const VERIFIABLE =
  /\b(test|tests|spec|specs|suite|passes?|passing|fail(s|ing)?|assert\w*|verif\w+|check\w*|benchmark\w*|measure\w*|reproduc\w+|exit code|compiles?|typecheck\w*|lint\w*|coverage|golden|fixture)\b/i

/** Vague improvement with no target. Each is fine WITH a criterion and empty without one. */
const VAGUE = /\b(improve|clean\s*up|tidy|refactor|modernise|modernize|optimi[sz]e|better|nicer|polish|simplify)\b/i

/** A cause stated as established fact rather than as something to establish. */
const ASSERTED_PREMISE =
  /\b(the bug is|the problem is|the issue is|caused by|because it(?:'s| is) (?:broken|wrong|failing)|which is why|due to a)\b/i

/**
 * Two independent asks joined together.
 *
 * The word forms need a boundary; the semicolon form IS its own boundary, and an earlier
 * version applied `(^|\W)` to both -- which meant `Add caching; also rewrite the docs`
 * never matched, because the character before the semicolon is a word character.
 *
 * `then` or `also` after the semicolon is REQUIRED rather than optional. Optional, it matched
 * any semicolon at all -- so `Done means: the suite passes; new tests cover the change` was
 * flagged as two asks. That is not a near miss: it is the exact shape
 * `no_acceptance_criteria` asks an author to write, so the two rules were pulling against
 * each other and the one that fired second won. Caught by linting a real goal for a real run.
 */
const CONJOINED = /\b(?:and then|and also|as well as)\b|;\s*(?:then|also)\s+\w/i

/**
 * Acceptance criteria, which are a LIST by nature and must not be read as a list of asks.
 *
 * Everything from the first "done means" onwards is the author saying how the single ask
 * above will be judged. Conjunctions there join criteria, not goals -- and a rule that
 * cannot tell the difference punishes the goals that took the trouble to be checkable.
 */
const CRITERIA_MARKER = /\b(?:done means|acceptance(?: criteria)?|definition of done|success (?:means|is))\b/i

/** The ask alone: everything before the criteria, or the whole goal when there are none. */
function askPortion(text: string): string {
  const m = CRITERIA_MARKER.exec(text)
  return m ? text.slice(0, m.index) : text
}

/**
 * Lint a goal. Empty means nothing to say, which is the common case for a well-formed goal.
 *
 * Ordered most-actionable first: a goal with no acceptance criteria has one obvious fix, while
 * an asserted premise needs the author to think about what they actually know.
 */
export function lintGoal(goal: string): GoalFinding[] {
  const out: GoalFinding[] = []
  const text = goal.trim()
  if (!text) return out

  const verifiable = VERIFIABLE.test(text)

  if (!verifiable) {
    out.push({
      code: 'no_acceptance_criteria',
      message: 'nothing in this goal names something that could be run, compared or observed',
      consequence:
        'the participants have no way to know when they are done, and the outcome can only ' +
        'be graded reasoned_but_unverified however well the work goes',
    })
  }

  // Only when there is ALSO no criterion. "Refactor X until the suite passes" is a fine goal,
  // and flagging it would make this rule noise.
  if (VAGUE.test(text) && !verifiable) {
    out.push({
      code: 'unobservable_completion',
      message: 'asks for an improvement without saying what would count as one',
      consequence:
        'an advisor will declare DONE on its own judgement, and nothing in the record can ' +
        'contradict it',
    })
  }

  // The ASK, not the criteria. See `askPortion`.
  if (CONJOINED.test(askPortion(text))) {
    out.push({
      code: 'multiple_goals',
      message: 'reads as more than one ask joined together',
      consequence:
        'a run that finishes one and not the other has no way to report that: the outcome is ' +
        'a single value, so partial success is indistinguishable from full success',
    })
  }

  if (ASSERTED_PREMISE.test(text)) {
    out.push({
      code: 'asserted_premise',
      message: 'states a cause as established fact',
      consequence:
        'if the premise is wrong the participants will work from it anyway -- this is the ' +
        'earliest and cheapest place to notice that it was assumed rather than checked',
    })
  }

  return out
}

/** One line per finding, for a human or a log. */
export function formatGoalFindings(findings: GoalFinding[]): string[] {
  return findings.flatMap((f) => [`  goal: ${f.message}`, `        ${f.consequence}`])
}
