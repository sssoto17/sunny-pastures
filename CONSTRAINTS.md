# Constraints

The quality bar for Sunny Pastures: what "good enough to merge" means, with numbers, and which check
enforces each one. Agents write most of the code, so the bar lives in checks that run in the loop
instead of in a reviewer's head.

Last reviewed: 2026-11-07 by Soto (interview on #34, review of PR #45, interview on #47).

## How to use this file

- **Read it before writing code.** Don't weaken it to make a change pass: fix the code, or add an
  exception the admin approves (see [Exceptions](#exceptions)).
- **Every failing check blocks the merge**, except the rows marked _warn_. There is no legacy code
  to grandfather in, and a warning in a PR nobody reads line by line isn't a check.
- **When a row starts blocking:** from the first PR after the issue that builds its check merges.
  Preview rows start at the first preview deploy (#43, M4). Until then the check isn't marked
  required, because a required check that never reports blocks every merge.
- **This file is canonical.** The `pnpm check:*` scripts and CI jobs mirror it. If they drift, this
  file wins.
- **Who edits it:** agents may propose a tightening (a ratchet update, a first recorded value) in a
  PR of its own. Only the admin loosens anything. CODEOWNERS (ADR-0002, appendix A3) makes this
  file need the admin's approval, and the floor guard checks every change to it.
- The requirement each row serves is in [`docs/requirements/spec.md`](docs/requirements/spec.md).
  Its baseline qualities BASE-01–05 are Musts that apply to every item (see
  [`moscow.md`](docs/requirements/moscow.md)).

**Status on 7 Nov 2026:** written only. There is no code, CI or test runner yet. Each row names the
issue that turns it into a check. Until those land, review enforces the floor.

## Floor (always enforced)

Checked in the diff against the merge base by the floor guard (`guard / floor`, #40), adapted from
[`floor-guard.md`](.agents/skills/constraint-driven-development/references/floor-guard.md). It
reports the rule and the location, never a matched value. A change to this file is the one place
it quotes text: see [Guarding the bar](#guarding-the-bar).

**A weakened bar is blocked unless the same PR adds an [Exceptions](#exceptions) row.** That row
changes this file, so the PR needs the admin's approval (a code-owned path, ADR-0002 area 2). A weakened bar is any
of:

- A new suppression comment: `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `eslint-disable`,
  `istanbul ignore`, `c8 ignore`, `v8 ignore`, `Stryker disable`, `nosemgrep`, `gitleaks:allow`,
  `fallow-ignore-next-line`, `fallow-ignore-file`, `# noqa`, `# type: ignore`.
- A skipped, focused or deleted test: `.skip`, `.only`, `.todo`, a removed test file, or
  assertions removed from a test that stayed. A moved or renamed test file is not a deletion: the
  guard uses git's rename detection.
- A moved threshold: a number in this file lowered, a severity dropped, a check moved to a later
  stage or removed.
- A tool config edit that excludes a path, ignores a finding or relaxes a rule. That counts as a
  moved threshold. The files: `.gitleaksignore` and `.gitleaks.toml`, `osv-scanner.toml`,
  `.semgrepignore`, coverage `exclude` in `vitest.config.*`, rules turned off in
  `eslint.config.*`, `strict` options relaxed in any `tsconfig*.json`, Stryker ignore patterns,
  assertions turned off in `lighthouserc.*`, `disableRules` in the axe setup, and the Fallow
  config.

Also blocked, with no exception possible:

- Unimplemented stubs: `throw new Error("Not implemented")`, an empty `catch {}`, a `TODO`
  standing in for the implementation.
- Secrets in source. Read them from env vars and keep placeholders in `.env.example`.
- An expired row in [Exceptions](#exceptions).

## Enforced with numbers

All rows block, except where _warn_ is noted. "Runs at" uses the stages under [Stages](#stages).
"Required check" is the status-check name on `main` (ADR-0002 names the checks; this file names
the thresholds).

| Dimension | Rule | Why this number | Checked by | Runs at | Required check | Enforced by |
|---|---|---|---|---|---|---|
| Types | 0 type errors | Any error is a bug or a lie | `tsc -b` (incremental) | edit, CI | `ci / typecheck` | #40 |
| Lint | 0 errors from the project config | The config is the standard; a warning nobody fixes is noise | `eslint .` | edit, CI | `ci / lint` | #40 |
| Coverage: `packages/sim` | Changed lines ≥ 90% covered | The sim is the research contribution, and a pure module with no I/O is cheap to cover | Vitest coverage (v8) lcov ∩ `git diff` | task end, CI | `ci / test` | #40 |
| Coverage: rest of `apps/` and `packages/` | Changed lines ≥ 80% covered | High enough that new logic needs a test; the rest leaves room for defensive branches that unit tests can't reach without contortions | Vitest coverage (v8) lcov ∩ `git diff` | task end, CI | `ci / test` | #40 |
| Boundaries: sim purity (MUST-10.1) | 0 violations. `packages/sim` imports nothing outside itself and no `node:*`, and calls none of `Date.now`, `Math.random`, `performance.now`, `crypto.getRandomValues`, `crypto.randomUUID`, `fetch`, `setTimeout`, `setInterval`, `setImmediate`. `new Date()` with no arguments is banned too; test files in `packages/sim` (`*.test.ts`) may also import `vitest` and `fast-check` and nothing else from outside the sim, and stay banned from `node:*` and from the calls above (admin, 9 Nov, #81) | The determinism claim depends on it, and the spec asks for a check, not review | Fallow boundaries with `boundaries.calls.forbidden`; ESLint `no-restricted-syntax` for argument-less `new Date()`, since Fallow checks direct callees, not constructors | edit, CI | `ci / boundaries` | #41 |
| Boundaries: server-only (`AGENTS.md`) | 0 violations: client code never imports `apps/web/src/server/` | `AGENTS.md` makes `src/server/` server-only | Fallow boundaries | edit, CI | `ci / boundaries` | #41 (once `apps/web` exists, M3) |
| Sim speed | `advance()` across 30 days on the largest content farm ≤ 50 ms; `apply()` ≤ 1 ms per call | Offline catch-up runs inside a request with a 300 ms p95 budget (BASE-04), so the sim may use at most a sixth of it | `vitest bench` (built in), farm read from content data; see [Timing checks](#timing-checks) | task end, CI | `ci / bench` | #41 |
| Determinism (MUST-17.1) | The same recorded action script gives the same state hash in two separate runs | The research question's core claim | ADR-0001's step-0 gate, run in CI | CI | `ci / determinism` | #48 |
| Assertion strength _(warn)_ | Mutation score ≥ 60% on changed `packages/sim` files | Typical for a suite never mutated before (80% is mature). It answers "the agent wrote the tests too" | Stryker `--mutate <changed files>`; the weekly `retro` reads the warnings | CI, when `packages/sim` changes | `ci / mutation` (not required) | #41 |
| Acceptance (MUST-15.3) | All acceptance tests pass over HTTP against a fresh stack | The black-box contract agents can't change (MUST-15) | `tests/acceptance/**` against a throwaway Supabase stack | CI | `ci / acceptance` | #49 (M3) |
| Secrets | 0 findings | Any finding is a leak | `gitleaks git --redact --no-banner` over the PR's commit range, with full history fetched (v8.30.1; `detect` is deprecated since v8.19) | CI | `guard / secrets` | #42 |
| Dependencies | Nothing at high or above | Below high is mostly noise | `pnpm audit --audit-level=high` (reads pnpm's lockfile natively) | CI | `ci / audit` | #42 |
| Code security | 0 findings at severity ERROR | ERROR is Semgrep's highest severity. The rule packs cover the OWASP Top 10, though `p/owasp-top-ten` may follow the 2021 list rather than MUST-16's 2025 mapping (spec Open question 3) | `semgrep scan --config p/default --config p/owasp-top-ten --severity ERROR --error --baseline-commit <merge base>` | CI | `guard / code-scan` | #42 |
| Page performance | Lighthouse mobile: LCP ≤ 2500 ms, CLS ≤ 0.1, TBT ≤ 200 ms | Core Web Vitals "good". Lab tests can't measure INP, so TBT stands in for it | Lighthouse CI against the Vercel preview; see [Timing checks](#timing-checks) | preview | `preview / lighthouse` | #43 |
| Accessibility (BASE-03) | 0 critical or serious violations | Moderate and minor findings are often debatable | axe-core, tags `wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa`, against the preview | preview | `preview / axe` | #43 |
| Action latency (BASE-04) | p95 < 300 ms on the deployed stack | Already in the spec | `Server-Timing` totals (MUST-19.1) from a scripted run against the preview; at load, SHOULD-03; see [Timing checks](#timing-checks) | preview, gate | `preview / latency` | #43 |
| Browsers and widths (BASE-02) | Latest 2 Chrome, Firefox and Safari; desktop and 360 px | Already in the spec | browser tests (tool decided in #44) | CI | `ci / ui` | the follow-up issue #44 creates when it decides |
| Prediction (BASE-05) | Shows ≤ 100 ms after a tap (MUST-12.1) | Already in the spec | browser timing test (tool decided in #44) | CI | `ci / ui` | the follow-up issue #44 creates when it decides |

**What counts for coverage.** Only source files under `apps/` and `packages/`. Tests, config files,
generated code and `tools/` are excluded, and the exclusion list lives in `vitest.config.*` (so
widening it is a moved threshold). A PR with no executable changed lines passes. Coverage comes
from the unit and property tests in the same Vitest run. The acceptance tests run over HTTP against
a separate stack and don't count.

**External opinions.** gitleaks, `pnpm audit`, Semgrep, axe and Lighthouse judge the code by rules
this project didn't write, so an agent can't make them pass with code that doesn't work. The
coverage and mutation rows measure the project's own tests, and Stryker is the check on those
tests.

### Timing checks

CI runners are shared, so one timing can swing by tens of percent between runs of the same code. A
check that fails at random teaches everyone to rerun until it's green, so the timing rows never
judge a single measurement:

| Check | Warm-up | Measured | Compared with the budget |
|---|---|---|---|
| `advance()` bench | 3 runs, discarded | 5 runs | the median of the 5 runs |
| `apply()` bench | 3 runs, discarded | 5 runs, each calling `apply()` at least 1,000 times on varied actions | the median across runs of the mean time per call |
| Lighthouse | 1 run, discarded (cold start) | 3 runs | each metric's median across the 3 runs |
| Latency smoke | 5 requests, discarded (cold start of the function and of staging Supabase) | at least 50 actions, never fewer than 20 | the p95 of the measured actions |

- **Over budget:** the job re-measures once with a full new set (5 bench runs, 3 Lighthouse runs,
  a new latency run) and fails only if both sets are over. One automatic retry, never more.
  Retrying by hand until the check is green counts as weakening the bar.
- **Flaky:** if a timing check fails on unchanged code (a rerun of `main` goes red), fix the
  measurement in its own PR rather than moving the threshold.

## Ratchets (hold today's value)

No honest number exists before the code does. A ratchet records the first value, then blocks any PR
that makes it worse past the tolerance. When the number improves, an agent may propose the new value
in a PR of its own.

| Metric | Today | Direction | Tolerance | Recorded by |
|---|---|---|---|---|
| Project coverage | not yet: recorded after the first `packages/sim` PR | must not fall | 0.5 points | #40 |
| First-load JS of the game route | not yet: recorded at the first preview deploy | must not grow | 5% per PR | #43 |
| CI runner time per PR | not yet: measured over #40's first week | must fit the Pro plan's monthly included Actions compute (about $18, ADR-0002) at the expected PR volume | n/a: a breach is reviewed, not blocked | #40 |

To keep CI cost down, the expensive checks run only when they're relevant. Stryker runs only when
`packages/sim` changes. Lighthouse, axe and the latency smoke run only on preview deploys. Semgrep
scans only from the merge base.

## Checked by review

These have no tool that can decide them. The admin checks them at each milestone gate
(`docs/diagrams/workflow.md`).

| Requirement | What is checked |
|---|---|
| BASE-01 | The UI is in English. |
| BASE-03 | The WCAG 2.2 AA criteria axe can't see (it covers roughly a third): keyboard order, focus visible, meaningful labels, target size, motion. |

## Stages

A check that stalls the agent gets switched off, so the cost of a check decides where it runs.

| Stage | Command | Runs | Budget |
|---|---|---|---|
| After each edit | `pnpm check:fast` (agent hook, proposed in #40) | Incremental typecheck (`tsc -b`), lint on changed files, floor guard, boundaries | under 5 s |
| Task end, before the agent opens a PR | `pnpm check:task` | `check:fast`, plus related unit and property tests (fixed seed, capped runs), coverage of changed lines, sim benchmark | ≤ 90 s |
| Every PR | CI (`pnpm check:full` + scan jobs) | Everything above, plus larger property runs, the determinism gate, gitleaks, `pnpm audit`, Semgrep, Stryker _(warn)_, acceptance tests | unlimited |
| Every preview deploy | CI against the Vercel preview | Lighthouse, axe, bundle ratchet, latency smoke | unlimited |
| Milestone gate | the admin | [Checked by review](#checked-by-review), BASE-04 from the metrics | n/a |

- **Over budget:** moving a check to a later stage is a moved threshold, so it needs an admin PR.
  One move is approved here in advance: if incremental `tsc -b` takes more than 5 s once `apps/web`
  exists (M3), typecheck moves from "after each edit" to "task end".
- **M3 watch:** 90 s at task end gets tight once `apps/web` adds its tests. Review this budget at
  M3's kickoff. The first lever is running only the tests related to the change.

Each blocking CI job is a required status check on `main`. The ruleset comes from ADR-0002
(PR #35).

## Tools are dependencies

Every tool named here (ESLint, Vitest and its v8 coverage, fast-check, Fallow, Stryker, Semgrep,
gitleaks, Lighthouse CI, axe-core and any browser-test tool) needs the admin's approval and an
exact pinned version (`AGENTS.md`). `minimumReleaseAge` in `pnpm-workspace.yaml` covers npm
packages only. For binaries, container images and GitHub Actions, the 7-day rule is checked by
hand, and Actions are pinned by commit SHA. `vitest bench` is built into Vitest, so the benchmark
adds nothing.

## Admin review (escalation and split size)

ADR-0002 (area 2) owns the mechanism: the reviewer bot approves a PR, which then auto-merges, or
requests changes, and the label `review:admin` holds a PR for the admin. The bot never approves a
PR that carries it, and only the admin removes it. This file owns when a PR gets the label and when
the bot asks for a split. Auto-merge stays off until this section is merged (ADR-0002, Q16).

### Escalation criteria

A PR that meets any row carries `review:admin`. An agent that knows it adds the label at
`gh pr create --label review:admin`. The reviewer bot checks every row on each review and adds the
label when it's missing. Whoever adds it also posts a one-line comment that names every row the PR
meets, for example "escalated: interface (sim exports)". Those comments are the tuning data
(below). The bot checks these rows before the [split size](#split-size), so on a PR it escalates,
the size is only a note.

| Criterion | Applies when | Who adds the label | Why |
|---|---|---|---|
| Code-owned path | The diff touches a path in `.github/CODEOWNERS` (ADR-0002, appendix A3). That file is the canonical list of these paths. It covers a new dependency (`package.json`, `pnpm-lock.yaml`), an Exceptions row and any change to this file, and the configs that can weaken a check | the bot, matching the diff against CODEOWNERS; the agent when it knows | GitHub already holds these PRs for the code owner. The label makes `label:review:admin` the one queue of PRs waiting for the admin, which matters while the factory acts as the admin and GitHub can't request the admin's review on the admin's own PR (#37) |
| Weakened bar, before `guard / floor` | Until `guard / floor` (#40) is a required check: the diff shows any of the five ways under [Guarding the bar](#guarding-the-bar), on any path. Besides the label, the bot submits Request changes, which blocks the merge, unless the same PR adds an [Exceptions](#exceptions) row | the bot; the agent when it knows | D1: a weakened bar is blocked unless the same PR adds an Exceptions row. Until the guard is required, the bot holds that line, and the label shows the admin every attempt. Once the guard is required, it blocks instead, and the Exceptions row is code-owned |
| Feature slice | The PR closes (`Closes #N`) an issue labelled `feature`. The earlier parts of a split (`Part of #N`) don't meet this row, though another row may still apply | the agent; the bot from the linked issue's label | Each `feature` issue is a vertical slice the player can see, so the admin sees every change in behaviour once the slice is complete. Bugs, chores, tests and refactors stay with the bot. Mechanical: the bot reads the link and the label |
| Interface change | The diff changes, adds or removes any of: what a `packages/*` entry point exports (`packages/*/src/index.ts`, and `exports` in its `package.json`); the request or response schemas of the game API; the sim's state or action types. The paths are where the code is expected to land; update them when it does | the agent; the bot | The admin keeps ownership of how a module turns out (ADR-0002). Additions count, because adding an export is when its shape gets fixed. The sim's state and action types are the persisted format (ADR-0001: action log plus snapshots), so a change can break saved farms |
| Security-sensitive code | The diff touches a server-side mechanism a MUST-16 threat depends on: authentication and sessions; ownership and authorisation checks (T5, T6); the per-farm rate limit (T7); idempotency keys (T3); the action endpoint's input schema (T8); where server time is taken (T1); the farm's write path, its locking or transaction (T4). Rules in `packages/sim` are not this row (T2, T9): the interface, content and feature rows cover them. Migrations and RLS are code-owned already. At M3, once `apps/web/src/server/` exists, these become path globs here (for example `apps/web/src/server/auth/**`, the action route handler and its schema) | the agent; the bot | The bot feeds text the PR wrote to a model, so it is the reviewer most open to manipulation, and a miss here is a cheat or a leak |
| Content change | The diff changes, adds or removes any content data: grow times, prices, yields, XP, Level thresholds, capacities and delays (spec, "How to read this spec"). Expected at `packages/sim/src/content/**`; update the path when it lands | the agent; the bot | The spec makes the admin the owner of content data, and tuning content is a rules change: a farm is rebuilt by replaying its log (ADR-0001), so a new value can make an old action replay differently or be refused. Until #31 settles how logs survive that, the bot can't judge the risk. A new entry usually rides in a `feature` PR, which escalates anyway |
| PR doesn't match its issue | The diff does work outside the linked issue's scope. A `Closes #N` PR also escalates when it leaves one of the issue's acceptance criteria undone; a `Part of #N` PR is checked for scope only | the bot | Scope creep and silent gaps are what the admin would catch in the issue, not in the code. The criteria are checked once, on the PR that completes the issue, so a split isn't escalated part by part |
| No linked issue | The PR links no issue: neither `Closes #N` nor `Part of #N`. Each part of a split says `Part of #N`, and the last part says `Closes #N` | the bot | The board moves an issue to In review only when its PR says `Closes #N` (`docs/agents/issue-tracker.md`). Without a link, the bot can't check scope and the board loses the PR |
| Not converging | The bot has requested changes **3** times on the PR and its blocking findings still aren't fixed. It escalates instead of requesting changes a 4th time. A Request changes that only asks for a split doesn't count as a round | the bot | A fix-and-review loop costs a Claude run on every push (ADR-0002, Consequences). Three rounds is enough for a fix that's going to land |

The bot may still escalate on its own judgement beyond these rows (ADR-0002). It names its reason
the same way.

### Split size

The bot reviews a PR of at most **400 changed lines**. Above that, it submits Request changes that
ask for a split, suggests where to cut, and doesn't review the lines.

- **How a split links:** each part says `Part of #N`, and the part that completes the issue says
  `Closes #N`. Only that last part is checked against the issue's acceptance criteria, and only it
  meets the feature-slice row (see the rows above).
- **What counts:** added plus deleted lines across all files, tests and Markdown included. Tests
  count at full weight: the bot has to read them (the risk the mutation row exists for), and the
  coverage rows stop an agent from trimming tests below the floor to fit. If retros show tests
  trimmed on split PRs, revisit this as tuning. Not
  counted: `pnpm-lock.yaml` and any file marked `linguist-generated` in any `.gitattributes`
  (generated code, result data). A pure rename counts 0 lines. Every `.gitattributes` is
  code-owned, so widening what they exclude needs the admin.
- **Why 400:** an issue's PR aims at about 100–300 lines (ADR-0002, area 3), and 400 is the cap
  above that target, not the target. SmartBear's study of about 2,500 reviews at Cisco found that
  reviewers stop catching defects past roughly 200–400 lines. Google's small-CL guidance calls
  about 100 lines reasonable and 1,000 usually too large. A model reviewer also loses detail on
  long diffs. Measured on recent merged PRs, 400 would have passed #26 (155 lines), #45 (330) and
  #52 (177), and asked for a split on #19 (473), #36 (636), #56 (703) and most spikes. All six
  touched code-owned paths, so for them the size would only have been a note.
- **No cap on file count.** Lines measure the review's size. A change across many files with few
  lines each is still small.
- **Can't be split:** when even expand–contract batches (`to-tickets`) can't stay green on their
  own, the agent adds `review:admin` with a comment that names "split size" and says why, and the
  admin decides.
- **On an admin-review PR**, the size is a note, not a block. The bot flags it in its summary, and
  the admin decides whether to ask for a split. ADRs and the spec are long by nature.

### Tuning

The tuning loop in ADR-0002 (area 2) applies to these rows: a bad bot approval that happens twice
sharpens a row or moves paths to CODEOWNERS, and escalated PRs that keep coming back from the admin
unchanged loosen a row. Only the admin loosens. The signal itself (a label rather than a review
request) is ADR-0002's, and #37 checks whether a review request can replace it once every PR comes
from an App identity.

## Guarding the bar

At review, compare the diff against the merge base for the five ways a bar gets lowered:

1. **A threshold moved**: a number in this file lowered, a severity dropped, a check moved to a
   later stage or removed, or a tool config loosened (the list under
   [Floor](#floor-always-enforced)).
2. **A test got easier**: `.skip` or `.only` added, a test file deleted, assertions removed from a
   test that stayed, a property's run count cut.
3. **A checker was silenced**: any suppression from the [Floor](#floor-always-enforced) list.
   `istanbul ignore`, `v8 ignore`, `Stryker disable`, `nosemgrep`, `gitleaks:allow` and the
   `fallow-ignore-*` comments deserve extra attention: they switch off a check this file relies on.
4. **Work is unfinished**: a stub that throws, an empty `catch`, a `TODO` where the implementation
   should be.
5. **An exception appeared**: a new row below.

The floor guard (#40) catches all five in the diff. It blocks 1–3 unless the same PR adds an
exception, and it always blocks 4. A change to this file (1 and 5) also needs the admin's
approval through CODEOWNERS.

**What the guard can judge in this file.** It compares each rule with its old version: a number
moved the wrong way, a severity or a stage dropped, a listed item gone, a rule removed. It can't
read what new words mean. So whenever this file changes, the guard also reports every changed
rule, and every changed line outside a rule (a heading, a comment, a fence), with the old and new
text side by side and the edit marked. The report goes to the guard's log, the job summary and a
warning annotation on the changed line in the PR's Files changed tab (#122). GitHub shows 10
annotations per step, so with more changes the last one points to the job summary, which has them
all. Key-like text in the quotes is redacted. A rule that gains a narrowing word (`except`,
`unless`, `but not`, `only`, `may`, `other than`, `apart from` and a few more), gains or drops a
negation (`not`, `never`, …), or gains a clause of two or more words in a table's list cell is
marked `warning [rule-narrowed]`.

That warning isn't a _warn_ row and doesn't break "Every failing check blocks the merge": it rides
on a review that happens anyway, because every PR that touches this file carries `review:admin`.
It warns rather than fails (admin, 9 Nov): the guard can't tell an approved carve-out from an
unapproved one, and `guard / floor` is a required check with no bypass, so a failure could only be
cleared by an Exceptions row that expires. ADR-0004 records the choice.

**The admin's merge review reads every changed rule in that report**, including the ones the guard
passes. What the guard still can't catch, and leaves to that review:

- A rewording that changes the meaning with none of the words above and no new clause, such as
  "Only the admin loosens anything" becoming "Only the agent loosens anything".
- A carve-out in words that aren't on the list, or inside a code span.

It errs the other way on two edits, which fail as `rule-narrowed`, as they did before #122: a typo
fixed inside a table's list cell, and an item appended to a list cell right before a full stop.
Both read as a removed item.

## Exceptions

An exception lets one weakened bar through on one path for a limited time. The row is added in the
same PR as the weakening. It needs an owner, a reason and an expiry no more than 30 days out, and
never past the feature freeze on 20 Dec 2026 (90 days, the usual default, would outlive the
project). The admin approves the PR, because it changes this file.

IDs run `E1`, `E2`, …, and are never reused. The floor guard reads rows matching `| E<n> |` and
fails every PR once a row's expiry date has passed, until the row is removed or the admin renews
it.

| ID | Rule | Path | Reason | Owner | Expires |
|---|---|---|---|---|---|
| _none_ | | | | | |

## Interview record

The admin's answers on 7 Nov 2026 (#34), so a later change can see what was chosen and why.

1. **Dimensions:** coverage, security scanning, performance, accessibility and architecture
   boundaries, all blocking. Mutation score is a warning only.
2. **Block or warn:** block from day one.
3. **Numbers:** the proposed defaults, as recorded above.
4. **Slowest task-end check:** 90 seconds. Unlimited in CI.
5. **BASE-01–05:** become Musts that keep their BASE IDs, apply to every item and are never on the
   cut list.
6. **Linter:** ESLint.

Decided in the review of PR #45 (7 Nov):

- **D1:** a weakened bar is blocked unless the same PR adds an Exceptions row, which needs the
  admin's approval. "A reason in the commit message" is no longer enough.
- **D2:** this file owns the blast-radius numbers, ADR-0002 owns the mechanism (#47). Since #47,
  those numbers are the escalation criteria and the split size ([Admin review](#admin-review-escalation-and-split-size)).
- **D3:** `pnpm audit --audit-level=high` is the dependency check. osv-scanner stays only if #42
  shows it catches a known-vulnerable dev dependency in pnpm's lockfile.

Decided in the interview on #47 (7 Nov), for
[Admin review](#admin-review-escalation-and-split-size):

- **Code-owned PRs:** they carry `review:admin` too, added by the bot from CODEOWNERS, so the
  label is the one queue of PRs waiting for the admin. A new dependency, an Exceptions row and a
  loosened tool config fall under that row. Until `guard / floor` reports, the bot escalates a
  weakened bar on any path.
- **Feature slice, interface, security:** a feature slice is a PR that closes a `feature` issue.
  An interface change includes additions to `packages/*` exports, the game API's schemas and the
  sim's state and action types. Security-sensitive code escalates.
- **Content:** escalates. The first answer was "no, to avoid flooding the queue", reversed once
  the spec showed that the admin owns content and that tuning is a rules change.
- **The bot's triggers:** a PR that doesn't match its issue, that links no issue, or that hasn't
  converged after 3 rounds of Request changes. Every escalation names its rows in a comment.
- **Split size:** 400 changed lines, excluding `pnpm-lock.yaml` and files marked
  `linguist-generated`. Above it the bot asks for a split. On an admin-review PR it's a note only.
- **The label:** stays for now. #37 checks whether a review request can replace it once every PR
  comes from an App identity.

Decided in the coordinator's review of PR #57 (7 Nov):

- **Splits:** a PR links its issue with `Closes #N` or `Part of #N`. Only the `Closes` PR is
  checked against the acceptance criteria and meets the feature-slice row.
- **Security signals:** the server-side mechanisms MUST-16's threats depend on (T1, T3–T8), not
  the sim's rules. They become path globs at M3.
- **Weakened bar before the guard:** the bot also requests changes unless an Exceptions row is
  added (D1), until `guard / floor` is a required check.
- **Test lines:** count at full weight toward the split size.

Decided while building #122 (9 Nov), for [Guarding the bar](#guarding-the-bar):

- **Changes to this file:** the floor guard reports every one, old and new side by side, in its
  log, the job summary and annotations on the PR. A PR comment would have needed a floor-job change.
- **Carve-outs:** a narrowing word, a negation or a new clause warns as `rule-narrowed` and doesn't
  fail. A failure could only be cleared by an expiring Exceptions row, since `guard / floor` has no
  bypass, and the admin reads every PR that touches this file anyway.
