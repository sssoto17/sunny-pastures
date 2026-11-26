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
  PR of its own. Only the admin loosens anything. CODEOWNERS (ADR-0002, appendix A3) makes this file
  need the admin's approval, and the floor guard checks every change to it.
- The requirement each row serves is in [`docs/requirements/spec.md`](docs/requirements/spec.md).
  Its baseline qualities BASE-01–05 are Musts that apply to every item (see
  [`moscow.md`](docs/requirements/moscow.md)).

**Status on 7 Nov 2026:** written only. There is no code, CI or test runner yet. Each row names the
issue that turns it into a check. Until those land, review enforces the floor.

## Floor (always enforced)

Checked in the diff against the merge base by the floor guard (`guard / floor`, #40), adapted from
[`floor-guard.md`](.agents/skills/constraint-driven-development/references/floor-guard.md). It
reports the rule and the location, never a matched value. A change to this file is the one place it
quotes text: see [Guarding the bar](#guarding-the-bar).

**A weakened bar is blocked unless the same PR adds an [Exceptions](#exceptions) row.** That row
changes this file, so the PR needs the admin's approval (a code-owned path, ADR-0002 area 2). A
weakened bar is any of:

- A new suppression comment: `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `eslint-disable`,
  `istanbul ignore`, `c8 ignore`, `v8 ignore`, `Stryker disable`, `nosemgrep`, `gitleaks:allow`,
  `fallow-ignore-next-line`, `fallow-ignore-file`, `# noqa`, `# type: ignore`. Every other
  `fallow-ignore-*` form counts too (#99).
- A skipped, focused or deleted test: `.skip`, `.only`, `.todo`, a removed test file, or assertions
  removed from a test that stayed. A moved or renamed test file is not a deletion: the guard uses
  git's rename detection. A property test's run count (`numRuns`, `SIM_PROPERTY_RUNS`) lowered,
  deleted, or turned from a variable into a literal counts too (#99).
- A moved threshold: a number in this file lowered, a severity dropped, a check moved to a later
  stage or removed. In this file, numbers pair by what they count. A cap added in a unit the rule
  didn't use, joined with "or" (`≤ 50 ms or 5 s`), counts as a loosening, and so does a new number
  with no direction in a rule that had a cap or a floor (#99). A Dependabot PR that only moves a
  GitHub Action's pinned commit SHA, opened by Dependabot from this repo with only its own commits,
  isn't a removed check.
- A tool config edit that excludes a path, ignores a finding or relaxes a rule. That counts as a
  moved threshold. The files: `.gitleaksignore` and `.gitleaks.toml`, `osv-scanner.toml`,
  `.semgrepignore`, coverage `exclude` in `vitest.config.*`, rules turned off in `eslint.config.*`,
  `strict` options relaxed in any `tsconfig*.json` (or a new one with neither `extends` nor
  `strict`, #99), Stryker ignore patterns, assertions turned off in `lighthouserc.*`, `disableRules`
  in the axe setup, the Fallow config, a path added to `.prettierignore`, and in `.prettierrc` an
  `overrides` block, an ignore-like key, `requirePragma` or a dropped plugin; and a new, deleted or
  moved Prettier config file, a `prettier` key in a `package.json` or `package.yaml`, or a new or
  changed `.editorconfig`, each of which Prettier also reads (#125). In `eslint.config.*`,
  `vitest.config.*`, `tsconfig*.json`, and the Fallow, Stryker and Lighthouse configs written as JS,
  TS or JSON, and in a `.prettierrc` that parses as JSON to the same value, a change that only
  reformats (quotes, indentation, trailing commas, re-wrapped lists) isn't a loosening; any change
  in content still is (#138). The guard compares the whole file, so a reformat must be its own PR:
  mixed with a content change in the same config, it keeps every finding.

Also blocked, with no exception possible:

- Unimplemented stubs: `throw new Error("Not implemented")`, an empty `catch {}`, a `TODO` standing
  in for the implementation. Also "not yet implemented" and "unimplemented" stubs, a `catch` holding
  only a comment, and an empty `.catch(() => {})` (#99).
- Secrets in source. Read them from env vars and keep placeholders in `.env.example`.
- An expired row in [Exceptions](#exceptions).
- An Exceptions row the guard can't accept: a date it can't read, a Rule it doesn't know, a Path
  wider than one folder, or a second `## Exceptions` heading (#99).

**Vendored skills are not scanned by the floor guard** (#665, admin, 26 Nov 2026). A third-party
skill keeps its upstream author's code as shipped, so a `TODO` or a suppression in it is theirs, not
ours, and rewording it would come back with the next update. What counts as vendored is a record,
never a glob: a skill named in `skills-lock.json` (code-owned), in its two folders,
`.agents/skills/<name>/` and `.claude/skills/<name>/`. The entry needs a `source`, and its name is
one folder name. The guard reads the record from the PR's head, since the PR that vendors a skill
adds its entry, but a name the PR adds covers only a folder the merge base didn't have: recording a
folder that is already ours doesn't skip the edits made to it in the same PR. A file moved into or
out of a vendored folder is still scanned. The guard names every skill it skipped in its log. The
hooks, our own skills and everything else under `.claude/` stay scanned, and the secrets scan,
Semgrep and every other check still read vendored folders.

## Enforced with numbers

All rows block, except where _warn_ is noted. "Runs at" uses the stages under [Stages](#stages).
"Required check" is the status-check name on `main` (ADR-0002 names the checks; this file names the
thresholds).

<!-- prettier-ignore -->
| Dimension | Rule | Why this number | Checked by | Runs at | Required check | Enforced by |
|---|---|---|---|---|---|---|
| Types | 0 type errors | Any error is a bug or a lie | `tsc -b` (incremental) | edit, CI | `ci / typecheck` | #40 |
| Lint | 0 errors from the project config | The config is the standard; a warning nobody fixes is noise | `eslint .` | edit, CI | `ci / lint` | #40 |
| Formatting (ADR-0005) | 0 files that Prettier would change, across `*.{ts,tsx,mts,mjs,js,json}` | Quotes, indentation and import order don't drift between agents | `prettier --check`, settings in `.prettierrc` | edit, CI | `ci / lint` | #125 |
| Duplication (ADR-0005) | 0 clones in the changed files of `packages/sim`, source and tests: exact copies of 50 tokens and 5 lines or more; and no clone group introduced by the change anywhere else in the repo (the rest of `apps/` and `packages/`, `.github/scripts/`, `tests/`), where a clone group the change inherits, in a file it touches, doesn't fail it | A rule written twice drifts apart; a repeated rule becomes a shared module at its second occurrence | `fallow audit --base <merge base>` (gate `new-only`) through `pnpm audit:changed` and `.github/scripts/audit-changed.mjs`, which fails on an introduced clone group (Fallow 3.43.1's verdict only warns on one; it replaced `fallow dupes --changed-since <merge base>` in #503), settings in `.fallowrc.jsonc` | task end, CI | `ci / lint` | #125; #503 (whole repo) |
| Complexity (#503) | 0 functions introduced by the change over cyclomatic 20, cognitive 15 or CRAP 30, anywhere in the repo. Introduced means new over a threshold, newly over one, or grown into a higher severity tier; a function already over one that grows within its tier is a warning (`worsened`), and a finding in a test file is a warning (Fallow 3.43.1) | Fallow's defaults; a branchy function nobody tests is where a bug hides. The backlog on `main` (35 functions, 22 in `.github/scripts/`) is inherited, not grandfathered by a number | `fallow audit` through `pnpm audit:changed`, settings in `.fallowrc.jsonc` (`health`); CRAP from `coverage/coverage-final.json` when a test run left one (`check:task`, `check:full`), from Fallow's static estimate in `ci / lint` | task end, CI | `ci / lint` | #503 |
| Dead code (#503) | 0 unused files, exports, types or dependencies, and 0 unlisted dependencies or binaries introduced by the change, an export elsewhere that it leaves unused included. `fallow dead-code` exited 0 on #503's head, so the repo starts and stays at 0 | Code nobody calls still costs review and coverage; a missing dependency breaks a fresh install | `fallow audit` through `pnpm audit:changed`, settings in `.fallowrc.jsonc` (`entry`, `ignoreBinaries`, `ignoreExports`, each with its reason) | task end, CI | `ci / lint` | #503 |
| Coverage: `packages/sim` | Changed lines ≥ 90% covered | The sim is the research contribution, and a pure module with no I/O is cheap to cover | Vitest coverage (v8) lcov ∩ `git diff` | task end, CI | `ci / test` | #40 |
| Coverage: rest of `apps/` and `packages/` | Changed lines ≥ 80% covered | High enough that new logic needs a test; the rest leaves room for defensive branches that unit tests can't reach without contortions | Vitest coverage (v8) lcov ∩ `git diff` | task end, CI | `ci / test` | #40 |
| Boundaries: sim purity (MUST-10.1) | 0 violations. `packages/sim` imports nothing outside itself and no `node:*`, and calls none of `Date.now`, `Math.random`, `performance.now`, `crypto.getRandomValues`, `crypto.randomUUID`, `fetch`, `setTimeout`, `setInterval`, `setImmediate`. `new Date()` with no arguments is banned too; test files in `packages/sim` (`*.test.ts`) may also import `vitest` and `fast-check` and nothing else from outside the sim, and stay banned from `node:*` and from the calls above (admin, 9 Nov, #81); every file in a module's `tests/` folder counts as a test file here, test helpers included | The determinism claim depends on it, and the spec asks for a check, not review | Fallow boundaries with `boundaries.calls.forbidden`; ESLint `no-restricted-syntax` for argument-less `new Date()`, since Fallow checks direct callees, not constructors; ESLint `no-restricted-imports` for packages and `node:*`, since Fallow's rule packs can't match a `node:*` prefix | edit, CI | `ci / boundaries`; `ci / lint` for the ESLint parts | #41 |
| Boundaries: server-only (`AGENTS.md`) | 0 violations: client code never imports `apps/web/src/server/`; the zones in `.fallowrc.jsonc` (#329 decision 3): `routes` (`src/app/**/route.ts`) → `api`; `pages` (rest of `src/app/**`) → `sim` only; `api` → every server module and `sim`; `http` → type-only `sim` (#395); `game` → `rules`, `timing`, `sim`, type-only `store`; `store` → type-only `db` and `sim`; `rules` → `sim`; `auth` → `config`; `db` → type-only `config`; `config` and `timing` are leaves; test files only (ADR-0007 section 6): `game/**/tests/**` → also `store/tests/**` (the in-memory store; production `game` still reaches `store` type-only, #383), and the store gate (`store/tests/storeGate.db.test.ts`) → also `rules` and `sim` (#383); the route files' tests (`src/app/api/**/tests/*.test.ts`) → `routes` and `api` (#397); `api`'s tests (`server/api/tests/*.test.ts`) → `api`'s own rule, `api` and `store/tests/**` (the in-memory store; production `api` still builds B100, #470); `simVersions`, the sim's server-only `versions/` subpath in a zone of its own under the sim's purity calls rule, is reached by `api`, `rules`, the store gate and the tests of `game` and `api`, and by no client zone (#535); every file in `apps/web/src` is in a zone (`coverage.requireAllFiles`), and every `src/server/*/index.ts` starts with `import "server-only"` | `AGENTS.md` makes `src/server/` server-only; only the composition root wires modules together | Fallow boundaries; `server-only` fails `next build` on a client import | edit, CI | `ci / boundaries`; `ci / typecheck` runs `next build`, with no database variables (#433) | #41 (once `apps/web` exists, M3) |
| Migrations (#331 decision 7) | 0 migrations in `supabase/migrations/*.sql` edited, renamed or deleted since the merge base: migrations are forward-only, an applied migration is never edited, and a fix is a new migration; and 0 drift: `drizzle-kit check` passes and `drizzle-kit generate` writes no new migration from `apps/web/src/server/store/schema.ts` | A migration already applied to a database doesn't run again, so an edit leaves that database different from a fresh one; a `schema.ts` change with no migration leaves the code and the database apart | `pnpm db:check` (`supabase/drift.sh`) | CI | `ci / lint` | #372 |
| Sim speed | `advance()` across 30 days on the largest content farm ≤ 50 ms; `apply()` ≤ 1 ms per call | Offline catch-up runs inside a request with a 300 ms p95 budget (BASE-04), so the sim may use at most a sixth of it | `vitest bench` (built in), farm read from content data; see [Timing checks](#timing-checks) | task end, CI | `ci / bench` | #41 |
| Determinism (MUST-17.1) | The same recorded action script gives the same state hash in two separate runs | The research question's core claim | ADR-0001's step-0 gate, run in CI | task end, CI | `ci / determinism` | #48 |
| Assertion strength _(warn)_ | Mutation score ≥ 60% on changed `packages/sim` files | Typical for a suite never mutated before (80% is mature). It answers "the agent wrote the tests too" | Stryker `--mutate <changed files>`; the weekly `retro` reads the warnings | CI, when `packages/sim` changes | `ci / mutation` (not required) | #41 |
| Acceptance (MUST-15.3) | All acceptance tests pass over HTTP against a fresh stack, including `tests/acceptance/attack/`: T1–T5 and T8 each have a passing attack test (MUST-16.1; the rest in M6) | The black-box contract agents can't change (MUST-15) | `tests/acceptance/**` against a throwaway Supabase stack | CI | `ci / acceptance` | #49 (M3); #387 (attack tests) |
| Protected acceptance tests (MUST-15.2) | No `[bot]`-authored PR touches `tests/acceptance/**`: 0 files added, changed, deleted or renamed into or out of it by a PR whose author's login ends in `[bot]` (or whose user type is `Bot`); the admin's PRs pass | The factory can't change the contract it's judged by; the App's token sets the author, so an agent can't fake it (ADR-0007, section 6) | `.github/scripts/acceptance-guard.mjs`, the default branch's copy, over the PR's file list | CI | `guard / acceptance` | #384 |
| Secrets | 0 findings | Any finding is a leak | `gitleaks git --redact --no-banner` over the PR's commit range, with full history fetched (v8.30.1; `detect` is deprecated since v8.19) | CI | `guard / secrets` | #42 |
| Dependencies | Nothing at high or above | Below high is mostly noise | `pnpm audit --audit-level=high` (reads pnpm's lockfile natively) | CI | `ci / audit` | #42 |
| Code security | 0 findings at severity ERROR | ERROR is Semgrep's highest severity. The rule packs cover the OWASP Top 10, though `p/owasp-top-ten` may follow the 2021 list rather than MUST-16's 2025 mapping (spec Open question 3) | `semgrep scan --config p/default --config p/owasp-top-ten --severity ERROR --error --baseline-commit <merge base>` | CI | `guard / code-scan` | #42 |
| Page performance | Lighthouse mobile: LCP ≤ 2500 ms, CLS ≤ 0.1, TBT ≤ 200 ms | Core Web Vitals "good". Lab tests can't measure INP, so TBT stands in for it | Lighthouse CI against the Vercel preview; see [Timing checks](#timing-checks) | preview | `preview / lighthouse` | #43 |
| Accessibility (BASE-03) | 0 critical or serious violations | Moderate and minor findings are often debatable | axe-core, tags `wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa`, against the preview | preview | `preview / axe` | #43 |
| Action latency (BASE-04) | p95 < 300 ms on the deployed stack | Already in the spec | `Server-Timing` totals (MUST-19.1) from a scripted run against the preview; at load, SHOULD-03; see [Timing checks](#timing-checks) | preview, gate | `preview / latency` | #43 |
| Browsers and widths (BASE-02) | Latest 2 Chrome, Firefox and Safari; desktop and 360 px | Already in the spec | browser tests (tool decided in #44) | CI | `ci / ui` | the follow-up issue #44 creates when it decides |
| Prediction (BASE-05) | Shows ≤ 100 ms after a tap (MUST-12.1) | Already in the spec | browser timing test (tool decided in #44) | CI | `ci / ui` | the follow-up issue #44 creates when it decides |

**What counts for coverage.** Only source files under `apps/` and `packages/`. Tests and test
helpers (everything in a `tests/` folder, ADR-0005), config files, generated code and `tools/` are
excluded, and the exclusion list lives in `vitest.config.*` (so widening it is a moved threshold). A
PR with no executable changed lines passes. Coverage comes from the unit and property tests in the
same Vitest run. The acceptance tests run over HTTP against a separate stack and don't count.

**External opinions.** gitleaks, `pnpm audit`, Semgrep, axe and Lighthouse judge the code by rules
this project didn't write, so an agent can't make them pass with code that doesn't work. The
coverage and mutation rows measure the project's own tests, and Stryker is the check on those tests.

### Timing checks

CI runners are shared, so one timing can swing by tens of percent between runs of the same code. A
check that fails at random teaches everyone to rerun until it's green, so the timing rows never
judge a single measurement:

<!-- prettier-ignore -->
| Check | Warm-up | Measured | Compared with the budget |
|---|---|---|---|
| `advance()` bench | 3 runs, discarded | 5 runs | the median of the 5 runs |
| `apply()` bench | 3 runs, discarded | 5 runs, each calling `apply()` at least 1,000 times on varied actions | the median across runs of the mean time per call |
| Lighthouse | 1 run, discarded (cold start) | 3 runs | each metric's median across the 3 runs |
| Latency smoke | 5 requests, discarded (cold start of the function and of staging Supabase) | at least 50 actions, never fewer than 20 | the p95 of the measured actions |

- **Over budget:** the job re-measures once with a full new set (5 bench runs, 3 Lighthouse runs, a
  new latency run) and fails only if both sets are over. One automatic retry, never more. Retrying
  by hand until the check is green counts as weakening the bar.
- **Flaky:** if a timing check fails on unchanged code (a rerun of `main` goes red), fix the
  measurement in its own PR rather than moving the threshold.

## Ratchets (hold today's value)

No honest number exists before the code does. A ratchet records the first value, then blocks any PR
that makes it worse past the tolerance. When the number improves, an agent may propose the new value
in a PR of its own.

<!-- prettier-ignore -->
| Metric | Today | Direction | Tolerance | Recorded by |
|---|---|---|---|---|
| Project coverage | 99.8% | must not fall | 0.5 points | #40 |
| First-load JS of the game route | not yet: recorded at the first preview deploy | must not grow | 5% per PR | #43 |
| CI runner time per PR | 15.1 minutes per PR over the CI workflow's first week, 8 to 14 Nov 2026 (1,633 minutes for 108 PRs, across every workflow a PR starts; #98). With the 19 minutes of runs outside any PR, 1,652 that week: about 7,100 minutes a month at that pace, 2.4 times the 3,000 minutes that $18 buys at $0.006 a minute | must fit the Pro plan's monthly included Actions compute (about $18, ADR-0002) at the expected PR volume; must not grow past that budget (#309) | n/a: a breach is reviewed, not blocked | #40 |
| Reviewer cost per PR | $0.31 of Claude per reviewed PR, 12 Nov 2026 to the morning of 16 Nov ($6.55 over 44 reviews of 21 PRs, 7 of them cancelled before Claude ran; #98). Wk 2 total, 9 to 15 Nov 2026: about $14.25, from 1,749 runner minutes (about $10.49 at $0.006 a minute) and $3.76 of Claude | must not grow past the weekly budget set from this first data (ADR-0002, "Caps") | n/a: a breach is reviewed, not blocked | #98 |

Note on the "CI runner time per PR" row above: the runner time of `ci / acceptance` (#49), recorded
here as a note rather than in the row, because a new value in a ratchet row goes in a PR of its own:
2 to 3 billed minutes a run, measured on PR #508's own runs on 22 Nov 2026 (runs 45043493394 and
45043983689: 1 min 55 s and 2 min 17 s, of which 1 min 39 s and 1 min 53 s start the Supabase stack,
and 8 s and 11 s build the app and run the 12 tests). It is path-filtered (admin, 22 Nov): of the
107 commits that landed on `main` in the first week, 8 to 14 Nov, 47 touch what it covers. At that
share, about 47 runs a week run the tests (about 95 to 140 minutes), and the other 60 bill about 1
minute each for the filter alone: about 650 to 870 minutes a month at the first week's pace, against
930 to 1,400 unfiltered.

To keep CI cost down, the expensive checks run only when they're relevant. Stryker runs only when
`packages/sim` changes. Lighthouse, axe and the latency smoke run only on preview deploys. Semgrep
scans only from the merge base.

## Checked by review

These have no tool that can decide them. The admin checks them at each milestone gate
(`docs/diagrams/workflow.md`).

<!-- prettier-ignore -->
| Requirement | What is checked |
|---|---|
| BASE-01 | The UI is in English. |
| BASE-03 | The WCAG 2.2 AA criteria axe can't see (it covers roughly a third) on the interface: keyboard order, focus visible, meaningful labels, target size. On the map scene: ambient animation stills under `prefers-reduced-motion`, attention cues rest after a few pulses, pan and zoom work by keys and buttons (ADR-0010, section 2). |

## Stages

A check that stalls the agent gets switched off, so the cost of a check decides where it runs.

<!-- prettier-ignore -->
| Stage | Command | Runs | Budget |
|---|---|---|---|
| After each edit | `pnpm check:fast` (agent hook: `PostToolUse` in `.claude/settings.json`, #113) | Incremental typecheck (`tsc -b`), lint on changed files, floor guard, formatting check. Boundaries join this row when #41 adds them to `check:fast`; since #41 it runs them as `pnpm boundaries` | under 5 s |
| Task end, before the agent opens a PR | `pnpm check:task` | `check:fast`, plus related unit and property tests (fixed seed, capped runs), coverage of changed lines, sim benchmark, duplication in changed files, with the rest of the changed-code audit (complexity and dead code, #503), the determinism gate, and a full lint without the cache (typed rules read other files, and the cache only tracks each file's own content) | ≤ 90 s |
| Every PR | CI (`pnpm check:full` + scan jobs) | Everything above, plus larger property runs, the determinism gate, gitleaks, `pnpm audit`, Semgrep, Stryker _(warn)_, acceptance tests | unlimited |
| Every preview deploy | CI against the Vercel preview | Lighthouse, axe, bundle ratchet, latency smoke | unlimited |
| Milestone gate | the admin | [Checked by review](#checked-by-review), BASE-04 from the metrics | n/a |

- **Over budget:** moving a check to a later stage is a moved threshold, so it needs an admin PR.
  One move is approved here in advance: if incremental `tsc -b` takes more than 5 s once `apps/web`
  exists (M3), typecheck moves from "after each edit" to "task end".
- **M3 watch:** 90 s at task end gets tight once `apps/web` adds its tests. Review this budget at
  M3's kickoff. The first lever is running only the tests related to the change.

Each blocking CI job is a required status check on `main`. The ruleset comes from ADR-0002 (PR #35).

## Tools are dependencies

Every tool named here (ESLint, Vitest and its v8 coverage, fast-check, Fallow, Stryker, Semgrep,
gitleaks, Lighthouse CI, axe-core and any browser-test tool) needs the admin's approval and an exact
pinned version (`AGENTS.md`). So do the tools of the code style (ADR-0005, #125):
`eslint-plugin-check-file`, `prettier`, `@ianvs/prettier-plugin-sort-imports` and
`@vitest/eslint-plugin`. So does the floor guard's Markdown parser (#132): `micromark` and
`micromark-extension-gfm`. `minimumReleaseAge` in `pnpm-workspace.yaml` covers npm packages only.
For binaries, container images and GitHub Actions, the 7-day rule is checked by hand, and Actions
are pinned by commit SHA. `vitest bench` is built into Vitest, so the benchmark adds nothing.

## Admin review (escalation and split size)

ADR-0002 (area 2) owns the mechanism: the reviewer bot approves a PR, which then auto-merges, or
requests changes, and the label `review:admin` holds a PR for the admin. The bot reviews and
approves on the code alone, label or not (#566): the label and `guard / code-owned` are the hold,
never a withheld approval, and only the admin removes the label. Removing it on the PR's current
head is the admin's sign-off: `guard / code-owned` holds a PR that is code-owned or has ever carried
the label until the admin's own account removes it on the head, and a push or a removal by anyone
else puts it back (ADR-0002, area 2, "Solo-admin approvals"; #565). This file owns when a PR gets
the label and when the bot asks for a split. Auto-merge stays off until this section is merged
(ADR-0002, Q16).

### Escalation criteria

A PR that meets any row carries `review:admin`. An agent that knows it adds the label at
`gh pr create --label review:admin`. The reviewer bot checks every row on each review and adds the
label when it's missing, before it posts its review, with one plain PR comment that names every row
the PR meets, for example "escalated: Interface change, Code-owned path" (#566). That is all a
missed row does: it is never a finding, never a review thread, never a Request changes and never a
withheld approval. For the Code-owned path row, the check `guard / code-owned` adds the label from
the diff as well, with a comment of the same shape, on the PR's first run: it runs when the PR
opens, on each push and on each label change (#337, #565). A lane that adds the label when it opens
the PR writes no comment; the bot's review names the rows. Those comments and reviews are the tuning
data (below). The bot checks these rows before the [split size](#split-size), so on a PR it
escalates, the size is only a note.

<!-- prettier-ignore -->
| Criterion | Applies when | Who adds the label | Why |
|---|---|---|---|
| Code-owned path | The diff touches a path in `.github/CODEOWNERS` (ADR-0002, appendix A3). That file is the canonical list of these paths. It covers a new dependency (`package.json`, `pnpm-lock.yaml`), an Exceptions row and any change to this file, and the configs that can weaken a check | the check `guard / code-owned`, from the diff against `main`'s CODEOWNERS (#337); the bot, matching the diff against CODEOWNERS; the agent when it knows | GitHub already holds these PRs for the code owner. The label makes `label:review:admin` the one queue of PRs waiting for the admin, which matters while the factory acts as the admin and GitHub can't request the admin's review on the admin's own PR (#37) |
| Feature slice | The PR closes (`Closes #N`) an issue labelled `feature`. The earlier parts of a split (`Part of #N`) don't meet this row, though another row may still apply | the agent; the bot from the linked issue's label | Each `feature` issue is a vertical slice the player can see, so the admin sees every change in behaviour once the slice is complete. Bugs, chores, tests and refactors stay with the bot. Mechanical: the bot reads the link and the label |
| Interface change | The diff changes, adds or removes any of: what a `packages/*` entry point exports (`packages/*/src/index.ts`, and `exports` in its `package.json`); the request or response schemas of the game API; the sim's state or action types. The paths are where the code is expected to land; update them when it does; the sim's state and action types live in `packages/sim/src/state/` and in each feature module's folder (its `index.ts` or a `types.ts` sibling), since the package's `index.ts` lists names, not shapes; the game API's request and response schemas live in `apps/web/src/server/http/**` (the request guards), in `apps/web/src/contract/**` (the error codes `ErrorCode`, the error body `ErrorBody`, `FarmEnvelope` and `Answer`, shared with the client since #594, ADR-0010 section 5) and in the response bodies: `apps/web/src/server/api/farmRoutes.ts` builds them (`{ farm }` for `GET /api/farm`, `{ answer, farm }` for `POST /api/farm/actions`) from `FarmEnvelope` and `Answer` | the agent; the bot | The admin keeps ownership of how a module turns out (ADR-0002). Additions count, because adding an export is when its shape gets fixed. The sim's state and action types are the persisted format (ADR-0001: action log plus snapshots), so a change can break saved farms |
| Security-sensitive code | The diff touches a server-side mechanism a MUST-16 threat depends on: authentication and sessions; ownership and authorisation checks (T5, T6); the per-farm rate limit (T7); idempotency keys (T3); the action endpoint's input schema (T8); where server time is taken (T1); the farm's write path, its locking or transaction (T4). Rules in `packages/sim` are not this row (T2, T9): the interface, content and feature rows cover them. Migrations and RLS are code-owned already. At M3, once `apps/web/src/server/` exists, these become path globs here (for example `apps/web/src/server/auth/**`, the action route handler and its schema); since M3 (ADR-0007, sections 2–5; #398) they are, each with its tests: `apps/web/src/server/auth/**` (authentication and sessions, the verified `PlayerId`); `apps/web/src/server/http/**` (the request guards and the action endpoint's input schema, T8, with the error builder and headers); `apps/web/src/server/game/**` (idempotency, T3; where server time is read, T1; the write path, T4); `apps/web/src/server/store/**` (the commit and its transaction, T4, and the stored idempotency keys, T3); `apps/web/src/server/api/**` (the composition root, where server time is taken, T1, and the handlers that run `readPlayer` before every farm read or write, T5, T6); `apps/web/src/app/api/farm/**` (the game routes). The per-farm rate limit (T7) joins this list once its module lands | the agent; the bot | The bot feeds text the PR wrote to a model, so it is the reviewer most open to manipulation, and a miss here is a cheat or a leak |
| Content change | The diff changes a content value, or adds or removes a content entry: grow times, prices, yields, XP, Level thresholds, capacities and delays (spec, "How to read this spec"). The values live in the content data (`sliceContent` in `packages/sim/src/content/index.ts`, and each rules version's content once #154 lands). Code under `packages/sim/src/content/` that changes no value, such as the content check, doesn't meet this row | the agent; the bot | The spec makes the admin the owner of content data, and tuning content is a rules change: a farm is rebuilt by replaying its log (ADR-0001), so a new value can make an old action replay differently or be refused. ADR-0006 (#31) keeps old logs replayable by adding a rules version, but whether a change edits a released version, needs a version upgrade or changes a stored fact is the admin's call. A new entry usually rides in a `feature` PR, which escalates anyway |
| PR doesn't match its issue | The diff does work outside the linked issue's scope. A `Closes #N` PR also escalates when it leaves one of the issue's acceptance criteria undone; a `Part of #N` PR is checked for scope only | the bot | Scope creep and silent gaps are what the admin would catch in the issue, not in the code. The criteria are checked once, on the PR that completes the issue, so a split isn't escalated part by part |
| No linked issue | The PR links no issue: neither `Closes #N` nor `Part of #N`. Each part of a split says `Part of #N`, and the last part says `Closes #N` | the bot | The board moves an issue to In review only when its PR says `Closes #N` (`docs/agents/issue-tracker.md`). Without a link, the bot can't check scope and the board loses the PR |
| Not converging | The bot has requested changes **3** times on the PR and its blocking findings still aren't fixed. It escalates instead of requesting changes a 4th time. A Request changes that only asks for a split doesn't count as a round | the bot | A fix-and-review loop costs a Claude run on every push (ADR-0002, Consequences). Three rounds is enough for a fix that's going to land |

The bot may still escalate on its own judgement beyond these rows (ADR-0002). It names its reason
the same way.

**Agents never resolve review threads** (admin, 15 Nov 2026, #264). The bot reads its own finding
threads: while one is open it withholds its approval, so a thread an agent resolved would let it
approve over a finding nobody fixed. Since #566 it posts no escalation thread and reads none, and
the escalation threads from before are the admin's to resolve. A standard plus a check: the `deny`
rule on the GitHub MCP resolve-thread tool and the hook `.claude/hooks/block-thread-resolve.sh`,
which runs in cloud sessions too, stop it in Claude Code. Neither is the boundary: until agent PRs
come from the factory App (#107), GitHub sees the admin's account either way.

**Agents never submit a PR review or reply on a review thread** (admin, 22 Nov 2026, #497). They
answer a finding with a plain PR comment (`gh pr comment`), which creates no review. A review from a
session on the admin's account, and a thread reply is one, counts as the admin's review: under
#494's rule `guard / code-owned` read it as the sign-off on a PR the admin opened, and since #565
removed that rule it still reads as the admin's agreement in the timeline. The rule holds for every
session: lanes, the coordinator and the reviewers it dispatches (the CI reviewer App posts from
Actions). A standard plus a check: `deny` rules in `.claude/settings.json` on `gh pr review`, the
review and reply API paths and GitHub's MCP review tools, and the hook
`.claude/hooks/block-thread-resolve.sh`, which also refuses the `gh api` and GraphQL forms a rule
can't match and a GraphQL query it can't read.

### Split size

The bot reviews a PR of at most **400 changed lines**. Above that, it submits Request changes that
ask for a split, suggests where to cut, and doesn't review the lines.

- **How a split links:** each part says `Part of #N`, and the part that completes the issue says
  `Closes #N`. Only that last part is checked against the issue's acceptance criteria, and only it
  meets the feature-slice row (see the rows above). An earlier part describes the later parts
  without a closing keyword, even in prose about another part, a table or a code span: GitHub links
  "closes #N" wherever it sits (`guard / pr-body`).
- **How a split is built:** as a stack, all parts opened together. Part 1 is based on `main`, and
  each later part on the previous part's branch. Each part stays within the split size and is
  reviewed on its own diff (`gh pr diff`); the closing part's criteria check covers the whole stack.
  A fix for a part that merged early can ride in a later part's fix commit. After a part merges,
  `scripts/stack.sh refresh` rebases the open parts onto `main` and force-pushes them with a lease
  (GitHub retargets the next part but doesn't rebase it), and an edit to a lower part reaches the
  parts above with `scripts/stack.sh update`, the same way. Only the stack's own part branches are
  force-pushed, never `main`. GitHub records `Closes #N` only while the base is `main`, so the
  closing part's `closingIssuesReferences` is checked once its base is `main`; if it's empty, the
  admin re-links the issue in the UI.
- **The one entry point:** every lane and the coordinator opens, extends, updates and reads a stack
  with `scripts/stack.sh` (`open`, `add`, `update`, `refresh`, `status`), local or cloud. Never
  hand-chain bases: `guard / stack-base` fails a PR on another PR's branch outside a native stack. A
  stack merges whole; `ci` on `push` to `main` shows a partial merge that broke it (ADR-0002, area
  2, "Stacks").
- **What counts:** added plus deleted lines across all files, tests and Markdown included. Tests
  count at full weight: the bot has to read them (the risk the mutation row exists for), and the
  coverage rows stop an agent from trimming tests below the floor to fit. If retros show tests
  trimmed on split PRs, revisit this as tuning. Not counted: `pnpm-lock.yaml` and any file marked
  `linguist-generated` in any `.gitattributes` (generated code, result data). A pure rename counts 0
  lines. Every `.gitattributes` is code-owned, so widening what they exclude needs the admin.
- **Why 400:** an issue's PR aims at about 100–300 lines (ADR-0002, area 3), and 400 is the cap
  above that target, not the target. SmartBear's study of about 2,500 reviews at Cisco found that
  reviewers stop catching defects past roughly 200–400 lines. Google's small-CL guidance calls about
  100 lines reasonable and 1,000 usually too large. A model reviewer also loses detail on long
  diffs. Measured on recent merged PRs, 400 would have passed #26 (155 lines), #45 (330) and #52
  (177), and asked for a split on #19 (473), #36 (636), #56 (703) and most spikes. All six touched
  code-owned paths, so for them the size would only have been a note.
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
exception, and it always blocks 4. A change to this file (1 and 5) also needs the admin's approval
through CODEOWNERS.

**What the guard can judge in this file.** It compares each rule with its old version: a number
moved the wrong way, a severity or a stage dropped, a listed item gone, a rule removed. It can't
read what new words mean. So whenever this file changes, the guard also reports every changed or
moved rule, and every changed line outside a rule (a heading, a comment, a fence), with the old and
new text side by side and the edit marked. Only a blank-line edit passes with no report. The report
goes to the guard's log, the job summary and a warning annotation on the changed line in the PR's
Files changed tab (#122). GitHub shows 10 annotations per step, so with more changes the last one
points to the job summary, which has them all. Long key-like text in the quotes is redacted.

Each entry names its reasons, in two tiers (admin, 9 Nov), so a real carve-out stands out. These are
marked `warning [rule-narrowed]`, and their annotation says "may be narrowed":

- A rule moved under another list's introduction, such as from "Also blocked, with no exception
  possible:" to "A weakened bar is any of:".
- A rule that gains a carve-out phrase: `except`, `unless`, `but not`, `other than`, `apart from`,
  `excluding`, `exempt`, `ignore`, `allow`, `warn` and a few more.
- A rule that gains or drops a negation (`not`, `never`, …).
- A rule that gains an HTML comment, a footnote, or a clause in a table's list cell.

These are common in honest edits, so they're marked `note [check]`, and their annotation says "to
check":

- A new rule, or new text outside the rules.
- A new clause in a list item or a paragraph.
- Everyday words: `only`, `may`, `can also`, `fine`, `outside`, `skip`.

That warning isn't a _warn_ row and doesn't break "Every failing check blocks the merge": it rides
on a review that happens anyway, because every PR that touches this file carries `review:admin`. It
warns rather than fails (admin, 9 Nov): the guard can't tell an approved carve-out from an
unapproved one, and `guard / floor` is a required check with no bypass, so a failure could only be
cleared by an Exceptions row that expires. ADR-0004 records the choice.

**The admin's merge review reads every changed rule in that report**, including the ones the guard
passes. What the guard still can't catch, and leaves to that review:

- A rewording that changes the meaning with none of the words above and no new clause, such as "Only
  the admin loosens anything" becoming "Only the agent loosens anything".
- A carve-out in words that aren't on the list, or inside a code span.

It errs the other way on two edits, which fail as `rule-narrowed`, as they did before #122: a typo
fixed inside a table's list cell, and an item appended to a list cell right before a full stop. Both
read as a removed item.

## Exceptions

An exception lets one weakened bar through on one path for a limited time. The row is added in the
same PR as the weakening. It needs an owner, a reason and an expiry no more than 30 days out, and
never past the feature freeze on 20 Dec 2026 (90 days, the usual default, would outlive the
project). The admin approves the PR, because it changes this file.

IDs run `E1`, `E2`, …, and are never reused. The floor guard reads rows matching `| E<n> |` and
fails every PR once a row's expiry date has passed, until the row is removed or the admin renews it.

Only a row a PR adds waives anything, so a row already in `main`'s table is spent. The floor guard
names each spent row as a warning, and the next PR that edits `CONSTRAINTS.md` removes it. A PR that
doesn't otherwise edit this file leaves it there, since the edit would make the PR code-owned
(#310).

What a row must hold, checked by the floor guard (#99):

- **Rule** names the findings it waives, as the guard prints them, separated by commas. The waivable
  ones are the weakened-bar findings: `silenced-checker`, `test-made-easier`, `test-deleted`,
  `assertion-removed`, `property-runs-cut`, `config-loosened`, `check-removed`, and this file's
  `rule-removed`, `rule-narrowed`, `threshold-*`, `severity-dropped` and `stage-moved`. A finding
  the row doesn't name stays blocked, even on its Path. Any other name fails the row, so
  `unfinished-work` and the `exception-*` findings can't be waived.
- **Path** is one file (`packages/sim/src/a.ts`), or one folder with at least two segments
  (`packages/sim/`, `packages/sim/**`, `.github/workflows/`), with no other wildcard. A waiver
  across every package is in effect project-wide, and the sim is what the floor protects most
  (admin, 9 Nov). So `**`, `**/*.ts`, `packages/**`, `packages/*/src/**`, `.github/` and any other
  top-level folder fail as `exception-too-broad`. A Path no file can have (a leading `/`, `//`, or a
  `.` or `..` segment) fails as `exception-invalid`.
- **Reason** and **Owner** aren't empty, and the **ID** is used once in the file.
- **Expires** is a real calendar day the guard can read (`2026-11-30` or `30 Nov 2026`, not
  `2026-11-31`). Any other value fails every PR, as an expired row does.
- The file has one `## Exceptions` heading. A second one fails every PR.
- Only a row in that section's one table waives anything. The table must have exactly the header
  above, followed by its delimiter row, and be written at the left margin. A row anywhere else never
  waives: in a code fence (backticks or `~~~`), a comment, an HTML block (`<pre>`, `<details>`,
  `<div>`, …), a list item, a header without a delimiter row, or another table. A row of the table
  without an `E<n>` ID fails.
- Expiry, dates and repeated IDs are checked on every line shaped like a row, wherever it sits, with
  or without its outer pipes and inside a blockquote, so no formatting hides an expired row.

The guard reads this file with a Markdown parser, micromark with GFM, which follows CommonMark and
GFM for the cases above. Its own line parser, frozen from 9 Nov, was replaced by the follow-up for a
real Markdown parser, #132 (admin, 9 Nov). A known miss remains: an ID reused after its row was
removed in an earlier PR isn't caught, because the guard sees only the PR's own diff. Nor is a
closing tag inside `<![CDATA[ … ]]>` or `<? … ?>`: the browser reads both as a comment, but the
guard counts the tag, so an element it seems to close still holds the table, which still waives.

Since #132, a table inside an element that HTML above it left open waives nothing: a `<details>` (or
`<details/>`) followed by a blank line, anywhere above the table, even above the heading or inside a
paragraph. A level-2 Exceptions heading inside a block quote or a list item counts as a second one.

<!-- prettier-ignore -->
| ID | Rule | Path | Reason | Owner | Expires |
|---|---|---|---|---|---|

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
  those numbers are the escalation criteria and the split size
  ([Admin review](#admin-review-escalation-and-split-size)).
- **D3:** `pnpm audit --audit-level=high` is the dependency check. osv-scanner stays only if #42
  shows it catches a known-vulnerable dev dependency in pnpm's lockfile.

Decided in the interview on #47 (7 Nov), for
[Admin review](#admin-review-escalation-and-split-size):

- **Code-owned PRs:** they carry `review:admin` too, added by the bot from CODEOWNERS and by
  `guard / code-owned` at the PR's first run (#337, #565), so the label is the one queue of PRs
  waiting for the admin. A new dependency, an Exceptions row and a loosened tool config fall under
  that row. Until `guard / floor` reports, the bot escalates a weakened bar on any path.
- **Feature slice, interface, security:** a feature slice is a PR that closes a `feature` issue. An
  interface change includes additions to `packages/*` exports, the game API's schemas and the sim's
  state and action types. Security-sensitive code escalates.
- **Content:** escalates. The first answer was "no, to avoid flooding the queue", reversed once the
  spec showed that the admin owns content and that tuning is a rules change.
- **The bot's triggers:** a PR that doesn't match its issue, that links no issue, or that hasn't
  converged after 3 rounds of Request changes. Every escalation names its rows in a comment.
- **Split size:** 400 changed lines, excluding `pnpm-lock.yaml` and files marked
  `linguist-generated`. Above it the bot asks for a split. On an admin-review PR it's a note only.
- **The label:** stays for now. #37 checks whether a review request can replace it once every PR
  comes from an App identity.

Decided in the coordinator's review of PR #57 (7 Nov):

- **Splits:** a PR links its issue with `Closes #N` or `Part of #N`. Only the `Closes` PR is checked
  against the acceptance criteria and meets the feature-slice row.
- **Security signals:** the server-side mechanisms MUST-16's threats depend on (T1, T3–T8), not the
  sim's rules. They become path globs at M3.
- **Weakened bar before the guard:** the bot also requests changes unless an Exceptions row is added
  (D1), until `guard / floor` is a required check.
- **Test lines:** count at full weight toward the split size.

Decided while building #122 (9 Nov), for [Guarding the bar](#guarding-the-bar):

- **Changes to this file:** the floor guard reports every one, old and new side by side, in its log,
  the job summary and annotations on the PR. A PR comment would have needed a floor-job change.
- **Carve-outs:** a narrowing word, a negation or a new clause warns as `rule-narrowed` and doesn't
  fail. A failure could only be cleared by an expiring Exceptions row, since `guard / floor` has no
  bypass, and the admin reads every PR that touches this file anyway.
- **Two tiers:** strong signals (a move to another list, a carve-out phrase, a negation, a hidden
  comment or footnote, a clause in a list cell) stay `warning [rule-narrowed]`. Weak ones (a new
  rule or text, a clause in prose, everyday words) become `note [check]`, so the warning stays rare
  enough to stop at.

Decided in the #68 step-1 grill (12 Nov), re-checking
[Admin review](#admin-review-escalation-and-split-size) before auto-merge. On 12 Nov, 20 of 21
merged PRs needed the admin:

- **CODEOWNERS:** unchanged. Every path stays code-owned. Each one holds the rules the agents or the
  reviewer follow, or a place where the bar can be lowered quietly. Handing off `docs/adr/` or
  `docs/agents/` would have freed no 12 Nov PR, since each also hit another trigger. Every
  `package.json` stays too: a script edit can weaken a check without adding a dependency, and
  CODEOWNERS can't tell the two apart.
- **Content change:** narrowed to content values and entries. #216–#222 escalated on the folder path
  though their own comments said "no content value changed". Validation code changes no farm.
  ADR-0006 still applies: every value change escalates.
- **Weakened bar, before `guard / floor`:** removed. Its end condition is met: the `main checks`
  ruleset requires `guard / floor`, and the Exceptions row it needs is code-owned.
- **Kept as they are:** Code-owned path, Feature slice, Interface change (every 12 Nov hit was a
  persisted-format change), Security-sensitive code, the three process rows and the split size.
- **Same rows for every author:** a factory PR meets the same rows. The only difference stays #37's:
  on a factory PR, the bot also requests the admin's review when it escalates.
- **The signal:** as #37 planned, the review workflow adds `review:admin` and posts the escalation
  thread; #104 retires the label. (**Amended 26 Nov 2026, #566:** the label stays as the admin's
  gate (#495, #104 superseded), and the bot posts a plain `escalated: <rows>` comment, no thread.)
