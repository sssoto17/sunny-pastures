---
status: proposed
---

# Floor guard and coverage gate: how a change to the bar reaches the admin

`guard / floor` (`.github/scripts/floor-guard.mjs`) and the coverage gate
(`.github/scripts/coverage-gate.mjs`) are the checks that hold `CONSTRAINTS.md`'s bar in CI (#40).
`AGENTS.md` asks each module to name its patterns and the alternatives considered. This ADR is that
record for both scripts. It's written in parts: this first part covers how the guard handles a
change to `CONSTRAINTS.md` itself (#122). #99 adds the rest of the guard's design and the gate's.

## Reviewing a change to `CONSTRAINTS.md` (#122, decided 9 Nov)

### The problem

The guard compares each rule of `CONSTRAINTS.md` with its old version. It knows numbers and their
direction, severities, stages and listed items: a table's list cells split at `,`, `;` and sentence
ends, plus backticked tokens. It doesn't know what new words mean. In PR #121 the admin-approved
allowance on the sim purity row ("test files … may also import `vitest` and `fast-check`") first
failed as `rule-narrowed`. Moved behind a `;`, it kept every old item and passed as clean. The
change was legitimate and disclosed, but an unapproved "…except in X" would have passed the same
way. The admin's merge review was the only check on what the edit allowed, and nothing put the
edit in front of that review.

### The decision

1. **A change report.** Whenever `CONSTRAINTS.md` changes, the guard reports every changed rule,
   and every changed line outside a rule (a heading, a table header, an HTML comment, a fence). It
   prints old and new text side by side with the edit marked in git's word-diff style
   (`[-removed-]`, `{+added+}`), and a changed row shows only the cells that changed. The report
   goes to three places: the guard's log, the job summary (`$GITHUB_STEP_SUMMARY`), and one
   warning annotation per change. Annotations "are visible on GitHub in the Checks and Files
   changed tab of the pull request", and "GitHub Actions are limited to 10 warning annotations and
   10 error annotations per step"
   ([REST: check runs](https://docs.github.com/en/rest/checks/runs), checked 9 Nov). So past 10 the
   guard shows the possible narrowings first, and its last annotation points to the summary, which
   holds every change (1 MiB per step,
   [workflow commands](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands),
   checked 9 Nov). With a report, the guard never logs `clean` for a PR that changes the file.
2. **A narrowing warning.** A rule that gains a narrowing word (`except…`, `unless`, `but not`,
   `only`, `may`, `can also`, `other than`, `apart from`, `aside`, `besides`, `save for`,
   `exclud…`, `exempt…`, `allow…`, `permit…`, `waive…`, `optional…`, `no longer`, `as long as`,
   `provided that`, "does not apply") is marked `warning [rule-narrowed]`. So is one that gains or
   drops a negation (`not`, `no`, `never`, `none`, `nothing`, …), and a table row that gains a
   clause of two or more words in a list cell. Words are counted against the old rule, so
   rewording a rule that already says "only" doesn't trip it. Code spans don't count: they're names
   (`gitleaks:allow`), and adding one is how a list gets tighter.
3. **It warns; it never fails (admin, 9 Nov).** `guard / floor` is a required check in the ruleset
   `main checks`, which has no bypass (checked with `gh api` on 9 Nov; ADR-0002 describes only the
   ruleset `main`, whose admin bypass doesn't reach these checks). A failure could be cleared only
   by an Exceptions row on `CONSTRAINTS.md`, which lasts at most 30 days and then fails every PR
   until it's removed. The word list also trips on real tightenings ("only"). The admin reads every
   `CONSTRAINTS.md` PR anyway: the file is code-owned, so the PR carries `review:admin`.
4. **The quotes are made safe.** The report is the one place the guard prints text a PR wrote,
   against its rule of "the location, never the matched text". So under Actions the log is printed
   inside a `::stop-commands::` block with a random token, and no line of it can run as a workflow
   command. Indenting the lines isn't relied on: the review of #122 reported that the runner trims
   leading spaces before it reads a command (not checked against the runner's source). The
   annotations come after
   the block, with `%`, CR and LF escaped. Any run of 24 or more key-like characters with both a
   letter and a digit is replaced with `[redacted]` in all three places. gitleaks
   (`guard / secrets`, #42) is the check meant for secrets; this only keeps the report from
   repeating one.

The guard's existing failures don't change: a removed listed item is still a failing
`rule-narrowed`, and a lowered number is still `threshold-loosened`. A first build also split list
cells at full stops, so that an item appended before one wouldn't read as removed. The review
found that it let a new sentence in between two items with neither removed, which turned a failure
into a warning, so it was dropped.

### Patterns

| Pattern | Where | Why |
|---|---|---|
| Maker–checker (four eyes) | The report puts each edit in front of the admin, who merges | The guard can't judge meaning, so it makes sure a person who can sees every edit. |
| Tripwire at warning severity | The narrowing words and the new-clause rule | A cheap heuristic that catches the common shapes of a carve-out. A miss costs nothing extra, because the report shows the edit anyway. |
| Word-level diff (longest common subsequence) | The `[-…-]` / `{+…+}` marks | It shows what was added inside a long row, where a line diff marks the whole row. `,` and `;` are tokens of their own, so an appended clause is marked on its own. |

### Alternatives considered

- **Fail on a narrowing, cleared by an Exceptions row.** This was the first build. Rejected by the
  admin (9 Nov): approved carve-outs would each need a row that expires within 30 days and then
  fails every PR, and "only" trips on tightenings. An Exceptions row on `CONSTRAINTS.md` would also
  waive every other finding in the file.
- **Fail, cleared by an admin label** (`constraints:approved`). It needs a `labeled` trigger in
  `ci.yml`, a floor-job change, and agents can add labels too, so only instructions would hold it.
- **A PR comment instead of annotations.** It needs `pull-requests: write` and a new job or step.
  Main's guard flags any added line in the floor job as `check-removed`. Annotations need no token
  and sit on the changed line.
- **Route every added clause through an Exceptions row** (#122's second option). It has the same
  expiry cost as the first, on every edit.
- **Judge meaning with a model.** Not deterministic, and it reads text the PR wrote, which makes
  it the reviewer most open to manipulation (ADR-0002, area 2). Rejected.
- **Quote changed rows in the reviewer bot's escalation comment** (#55, 9 Nov). This complements
  the report rather than replacing it, and it waits for the reviewer App.

### What still passes, and who catches it

`CONSTRAINTS.md`, "Guarding the bar", lists it: a rewording that changes the meaning with none of
the listed words and no new clause ("Only the admin loosens anything" becoming "Only the agent
loosens anything", which a test holds), and a carve-out in other words or inside a code span. Each
still appears in the report, so the admin's merge review catches it. In the other direction, a
typo fixed inside a table's list cell, and an item appended right before a full stop, read as a
removed item and fail as before.

### Consequences

- Every `CONSTRAINTS.md` PR shows a report and never a `clean` line, tightenings included. That's
  more to read on a ratchet update, and it's the point: the admin sees every edit.
- The merge review is the control for meaning. If an unapproved carve-out ever merges, the weekly
  retro treats it as a missing safeguard (`docs/diagrams/workflow.md`, "Self-improving loops"), and
  the first lever is the word list.
- The guard runs from the base branch (#96), so this behaviour judges PRs only once it's on `main`.
  Its own PR was judged by the old guard. Its tests and dry runs on the real diffs (#121's
  rewording, an "…except in X") show the new behaviour.
- `floor-guard.mjs` now also holds a word diff and the workflow-command escaping. They stay in the
  file because CI copies only `floor-guard.mjs` and `diff.mjs` from the base branch, and a new
  module would need a floor-job change.
