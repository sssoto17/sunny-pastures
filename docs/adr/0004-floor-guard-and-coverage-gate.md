---
status: proposed
---

# Floor guard and coverage gate: how a change to the bar reaches the admin

`guard / floor` (`.github/scripts/floor-guard.mjs`) and the coverage gate
(`.github/scripts/coverage-gate.mjs`) are the checks that hold `CONSTRAINTS.md`'s bar in CI (#40).
`AGENTS.md` asks each module to name its patterns and the alternatives considered. This ADR is that
record for both scripts, and for `typecheck-reach.mjs`, which keeps `ci / typecheck` complete. Its
sections:
- how the guard handles a change to `CONSTRAINTS.md` itself (#122);
- Exceptions rows (#99, part 1);
- the guard's and the gate's design as a whole (#99, part 3), which also records part 2's (#133)
  patterns and number pairing.

## Reviewing a change to `CONSTRAINTS.md` (#122, decided 9 Nov)

### The problem

The guard compares each rule of `CONSTRAINTS.md` with its old version. It knows numbers and their
direction, severities, stages and listed items: a table's list cells split at `,` and `;`, plus
backticked tokens. It doesn't know what new words mean. In PR #121 the admin-approved
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
   `provided that`, "does not apply", and after the review of #129 `warn…`, `skip…`, `ignor…`,
   `outside`, `fine`) is marked `warning [rule-narrowed]`. So is a rule that:
   - gains or drops a negation (`not`, `no`, `never`, `none`, `nothing`, …);
   - gains a clause of two or more words: in a table row's list cell, or anywhere in a list item or
     paragraph, where a clause that only edits an old one (a typo fix) doesn't count;
   - gains an inline HTML comment or a footnote;
   - is new (any row, item or paragraph but an Exceptions row);
   - moved under another list's introduction (from "Also blocked, with no exception possible:" to
     "A weakened bar is any of:", say). Its text is unchanged, so it used to pair as unchanged and
     pass as `clean`. A rule reordered within its list is reported without a warning.

   Any new line outside a rule (a heading, a comment, a fence) is flagged too. Words are counted
   against the old rule, so rewording a rule that already says "only" doesn't trip it. Code spans
   don't count: they're names (`gitleaks:allow`), and adding one is how a list gets tighter. Only a
   blank-line edit passes with no report.

   **Two tiers (admin, 9 Nov).** With all of the above, most `CONSTRAINTS.md` PRs trip something,
   and a tag that's always there gets skimmed. So the weak reasons are a `note [check]` with their
   own annotation title ("to check"): a new rule, new text outside the rules, a new clause in prose,
   and the everyday words `only`, `may`, `can also`, `fine`, `outside`, `skip…`. Every other reason
   stays `warning [rule-narrowed]` ("may be narrowed"). Annotations list the warnings first. The
   cost: a carve-out written as a new rule with only everyday words ("Test files may use
   `@ts-ignore`.") is a note, not a warning. It's still reported in full.
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
  fails every PR, and "only" trips on tightenings. At the time, an Exceptions row on
  `CONSTRAINTS.md` would also have waived every other finding in the file. Since #99 a row waives
  only the findings its Rule column names.
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

The redaction is a courtesy, not a secrets check. It replaces runs of 24 or more key-like
characters that contain both a letter and a digit, so a shorter key, or one made only of letters,
is quoted as written. The text is in the PR's diff anyway, and gitleaks (`guard / secrets`, #42) is
the check for secrets (the admin, review of #129).

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

## Exceptions rows (#99, decided 9 Nov)

An Exceptions row lets one weakened bar through on one path for a limited time (`CONSTRAINTS.md`,
Exceptions). The #40 review found rows that waived too much, never expired, or hid where a
reader couldn't see them. Part 1 of #99 (#131) closes those gaps:

- **A row is scoped.** Its Rule column names the findings it waives, and nothing else on its Path
  is waived. Its Path is one file, or one folder with at least two literal segments, wherever it
  sits (admin, 9 Nov). So `packages/sim/`, `.github/workflows/` and `docs/adr/` pass, while
  `packages/**`, `.github/`, `docs/` and any other top-level folder don't. A waiver across every
  package is in effect project-wide, and the sim is what the floor protects most.
- **A row is complete and unique.** It has a reason and an owner, and its ID appears once in the
  file.
- **A row can't outlive its date.** An unreadable date, or an impossible one (`2026-11-31`), fails
  every PR, as an expired one does. `FLOOR_GUARD_TODAY` is ignored in CI.
- **A row can't hide.** Expiry, dates and repeated IDs are read from every row-shaped line in the
  file, whatever heading, fence, comment, HTML block or blockquote it sits in, with or without its
  outer pipes. Waivers come only from the one table with the Exceptions header and its delimiter
  row, at the left margin, under the one `## Exceptions` heading.
- **What the line parser follows.** It follows CommonMark for these constructs:
  - fences: backticks or tildes, indent of at most 3 spaces, and a bare closer;
  - ATX headings with an optional closing `#` run, and setext headings;
  - HTML comments;
  - HTML blocks of types 1 (`<pre>`, `<script>`, `<style>`, `<textarea>`), 6 (block tags such as
    `<details>` or `<div>`) and 7 (a complete tag alone on its line);
  - GFM tables, which need a delimiter row.

  **It's frozen from 9 Nov (admin).** The review of #131 found a new edge case on each round, the
  same pattern as #115's shell lexer. So any further case is listed as a known miss and goes to the
  follow-up for a real Markdown parser, #132 (under #58).
- **Known misses.**
  - An ID reused after its row was removed in an earlier PR: the guard sees one diff, not the
    history.
  - Anything CommonMark or GFM renders differently from the cases above.

**Patterns.**
- *Allowlist:* the Rule column takes only the names the guard emits as waivable findings, and a
  test keeps the two lists equal.
- *Fail closed:* anything the guard can't read is a failure, never a pass.
- *Two readers, one strict and one wide:* the waiver reader takes only well-formed rows, and the
  expiry reader checks every row-shaped line. A formatting trick can keep a row from waiving, but
  it can't keep the row from expiring.

**Alternatives considered.**
- *A maintained Markdown parser (remark or markdown-it).* It would read the file exactly as it
  renders. It's not adopted: the floor job runs with Node only and no install, so it would need a
  dependency and a floor-job change. It moved to #132 (admin, 9 Nov).
- *Refusing any wildcard in a Path.* Too strict: a folder waiver for one package is a legitimate
  case.
- *Checking only added rows for a bad date.* That was the old behaviour, and an old row with a bad
  date never expired.

## The guard and the gate as a whole (#99, decided 9 Nov)

### The floor guard

`guard / floor` reads the PR's diff against the merge base (`diff.mjs`) and fails a weakened bar
unless an Exceptions row waives it. It exits 0 when clean, 1 on a violation, and 2 when it can't
run; a 2 never reads as clean.

| Pattern | Where | Why |
|---|---|---|
| Diff-scoped check | Only added and removed lines, and the files they're in | A PR is judged on what it changes, so old code can't block it and new code can't hide in it. |
| Trusted code judges | CI runs the base branch's guard, not the PR's (#96), and the floor job runs pinned actions only, no local action from the PR's checkout (#99 part 4) | A PR can't weaken the guard that judges it, nor what runs before it. A change to the guard takes effect from the next PR. |
| Fail closed | Exit 2 on anything it can't read; an unreadable Exceptions row fails | Silence must mean "checked and clean", never "couldn't tell". |
| Denylist of weakening forms | Suppressions, skips, stubs, loosened configs, removed workflow steps | Each is a known shape of a lowered bar. #99 part 2 (#133) adds the forms the #40 review found passing: an empty `.catch`, a comment-only `catch`, "not yet implemented", every `fallow-ignore-*`, a deleted run count, a new tsconfig with neither `extends` nor `strict`. |
| Structural diff of `CONSTRAINTS.md` | Rules pair by section and key, then by similarity; numbers carry a direction and a unit | It compares what a rule says, not its line. With #99 part 2 (#133), numbers pair by unit before position, so a new cap added in front can't take an old one's place, and a cap in a new unit counts as a loosening. |
| Formatting is not content: whole-file normalized comparison (#138) | A guarded JS, TS or JSON config (by extension; YAML and extensionless files are left out, since indentation can be meaning) changed only formatting when its whole old text and its whole new text are equal once normalized: whitespace outside strings goes (one space stays between two words), a quoted string reads as its value (its escapes decoded, so its quotes and escapes don't matter), and trailing commas before a closing bracket go. Strings are scanned with their escapes and a template's `${…}`; template text and comments stay exact, and the code inside `${…}` is normalized too. A regex literal, an unclosed string, or a line break after `return`, `throw`, `break`, `continue` or `yield` makes the file unjudgeable. Then, and whenever anything else in the file changed, every finding in it stays. **So a reformat must be its own PR**: mixed with a content change in the same config, it keeps every finding | A formatter (Prettier, #125) needs no Exceptions rows. Reading the whole file from its first character is the only reading that knows whether a line sits in code, a string, a template or a comment. The first builds judged lines, then hunks. Their reviews showed a formatter changes boundary lines too (a scope swap and a reordered later-wins override slipped through), a hunk can start inside a comment or template opened above it, and a dropped trailing comma joins the next line onto an item. Alternatives: Exceptions rows per formatted file (rejected by the admin, 9 Nov), or parsing each config (no parser without an install in the floor job, #132) |
| Prettier's config is a guarded config (#125) | An added non-comment line in `.prettierignore` is `config-loosened`, as in `.gitleaksignore` and `.semgrepignore`; a `!` line re-includes a path, which widens the check, so it passes. In `.prettierrc`, an added line naming `overrides`, an ignore-like key or `requirePragma` is `config-loosened`, and so is a removed `prettier-plugin` that isn't added back. `.prettierrc` has no extension and may be YAML, so the #138 comparison doesn't apply to it; instead a change reads as formatting only when both versions parse as JSON to the same value. In `package.json` scripts, `prettier --check`, `fallow dupes`, `pnpm format:check` and `pnpm dupes` count as checks, and a `prettier --check` glob that loses a file type is `check-removed`. Both files are code-owned | The ignore list and the settings decide what the formatting check covers (admin, 9 Nov), so widening the list is the same moved threshold as a coverage exclusion. Alternatives: code-owned only (the admin's review would be the only check, with nothing in the guard's report), or renaming to `.prettierrc.json` so #138's comparison covers it (a rename for the guard's sake) |
| Time-boxed, scoped waiver | Exceptions rows | A weakened bar passes only on a named path, for named findings, until a date, with the admin's approval (code-owned). |
| Allowlist for one known change (#133) | A SHA-only `uses:` bump in the floor job, from Dependabot only | Dependabot's weekly bump would otherwise need the admin every week. The actor check stops an imposter commit from riding along. |

**Alternatives considered.**
- *An AST-based checker (the TypeScript compiler API, or custom ESLint rules).* It would see
  through spelling tricks that line patterns miss. It's not adopted: the floor job runs with Node
  only and no install, and ESLint already holds the rules that need a parse. The gap is the
  pattern list's known limit.
- *Running the PR's own guard.* Rejected in #96: a PR could switch it off.
- *A review bot instead of a script.* It's not deterministic, and it's the reviewer most open to
  manipulation (ADR-0002, area 2). The bot reviews as well, but it doesn't replace the guard.

**The routes past a red guard.** `guard / floor` is a required check in the ruleset `main checks`,
which has no bypass. So the admin's bypass merge on the ruleset `main` can't get a red guard
through. A blocked PR has three routes:
1. Fix the change.
2. Add an Exceptions row for the finding on the file's path, in the same PR, with the admin's
   approval (the file is code-owned). A workflow file is a valid Path, so `check-removed` on
   `.github/workflows/ci.yml` lets a floor-job change through.
3. The admin lifts `main checks` for that one merge, a ruleset change only the admin can make.

The guard's hint for `check-removed` names all three (#99 part 2).

**Package scripts count as checks (#99).** CI runs the PR's own `package.json` scripts. So a script
line that loses a check command (`tsc -b`, `eslint`, `vitest run`, one of the guard scripts), or a
script other than `check:task` that gains `--skip-ratchet`, is `check-removed` too.

### The coverage gate

`coverage-gate.mjs` reads the lcov the test run already wrote and intersects it with the diff:
changed lines need 90% in `packages/sim` and 80% elsewhere in `apps/` and `packages/`, and project
coverage must not fall more than 0.5 points below the recorded ratchet. The numbers are
`CONSTRAINTS.md`'s; this records the design.

| Pattern | Where | Why |
|---|---|---|
| Diff coverage | lcov ∩ changed lines | New code needs tests without old code blocking the PR. |
| Reuse the artifact | It reads `coverage/lcov.info` and never reruns the tests | One test run per job, within the stage budgets. |
| Ratchet with tolerance | The project coverage row | No honest number exists before the code. It holds the first value and blocks a fall past the tolerance. |
| Fail closed (#99) | Only "not yet" means no ratchet; any other cell it can't read exits 2 | A typo in the Today cell can't switch the ratchet off. |
| Partial runs skip the whole-project check (#99) | `check:task` passes `--skip-ratchet` | `vitest --changed` counts every untested file at 0%, so the project figure would read low. CI runs the full suite and checks it. |

**Alternatives considered.**
- *A hosted service (Codecov, Coveralls).* It needs an external service and a token, and the
  thresholds would live outside `CONSTRAINTS.md`.
- *Vitest's own `coverage.thresholds`.* They're whole-project only, and they sit in
  `vitest.config.*`, where an edit moves them.
- *Rerunning the related tests in the gate.* It doubles the test time.

### Typecheck reach

`typecheck-reach.mjs` runs after `tsc -b` in `pnpm typecheck` (#99). Every package that
`pnpm-workspace.yaml` matches must have a tsconfig.json that the root tsconfig references, because
`tsc -b` builds only referenced projects.

- *Pattern: a completeness check.* The workspace list is the source of truth, and the build graph
  must cover it. It fails closed. It reads the `packages:` list of `pnpm-workspace.yaml` with
  comments, blank lines and `!` exclusions, and it expands only plain folders and `dir/*`. Any
  other glob, an empty list, or a root tsconfig that isn't plain JSON exits 2. A package counts as
  referenced only through its own `tsconfig.json`.
- *Alternatives:* `pnpm -r exec tsc --noEmit` checks every package, but it loses build mode's
  caching and the project graph; a single root tsconfig that includes everything loses the
  per-package `lib` and `types` that keep the sim free of DOM and Node types (ADR-0003).

### Known limits

What the guard still can't judge in `CONSTRAINTS.md` is listed there, under "Guarding the bar". It
covers a rewording that changes meaning without the listed words, and a carve-out in other words.
#122 replaced #99's original note that "a rewording that changes meaning without changing tokens
passes". The Markdown parsing is frozen, and its edge cases are #132's.
