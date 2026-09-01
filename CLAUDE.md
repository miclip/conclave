# Working on Conclave

## Dogfood it

**Use Conclave to do the work here.** This is the project's own tool; running it on its own
issues is the only way its faults show up as faults rather than as reports.

```sh
conclave session "<the issue, stated as a goal>" --checks "npm test"
```

Reach for it by default on anything that is a piece of work rather than a question: fixing an
issue, adding a feature, a refactor. Not for reading a file or answering something in one
step.

What it is for beyond the work itself: every run is evidence about the tool. A pause that
fires wrongly, a verdict graded worse than the run deserved, a briefing that produced the
wrong instruction, a console that redrew badly — those are findings, and they should be filed
as issues on sight. Several of this project's real bugs were found exactly that way.

`--operator agent` when nobody is at the console: it changes what the advisor is told about
who is answering, and it is recorded in the run report.

Say so when you did NOT use it and why. "I did this by hand because X" is a legitimate
answer; doing it by hand silently is not, because the missing runs are missing evidence.

## House rules that are not obvious

**Mutation-test every claim.** After a test passes, break the line it is supposed to be
guarding and confirm THAT test fails — and no other. Restore byte-for-byte and verify with
sha256. Tests that could not fail have shipped here more than once, and each time the mutation
is what caught it.

**Verify the mutation applied.** A mutation whose string did not match leaves the source
untouched and a green run that looks identical to a passing check.

**File issues on sight, without asking.** A defect noticed while doing something else is
filed, with the evidence, before it is forgotten.

**A comment about another program is a claim with an expiry date.** `hookEventNames.test.ts`
exists because two of them went stale silently. Check such claims against the installed
binary rather than restating them.

**Citations are checked.** `path:line` references in sources and in docs `## LIVE:` sections
are pinned by `src/contract/citations.test.ts`. `npm run citations:fix` repairs the ones that
moved cleanly; it refuses the ones that need a decision, and those are repaired by hand.

**The README is for running it; `docs/DESIGN.md` is for why.** Rationale prose belongs in the
second. The README was 7,100 words of the first doing the job of the second, and it is not to
grow back.
