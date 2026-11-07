# Constraints

The quality bar for Sunny Pastures: what "good enough to merge" means, with numbers, and which check
enforces each one. Agents write most of the code, so the bar lives in checks that run in the loop
instead of in a reviewer's head.

Last reviewed: 2026-11-07 by Soto (interview on #34).

## How to use this file

- **Read it before writing code.** Don't weaken it to make a change pass: fix the code, or ask the
  admin for an exception (see [Exceptions](#exceptions)).
- **Every failing check blocks the merge from day one**, except the rows marked _warn_. There is no
  legacy code to grandfather in, and a warning in a PR nobody reads line by line isn't a check.
- **This file is canonical.** The `pnpm check:*` scripts and CI jobs mirror it. If they drift, this
  file wins.
- **Only the admin changes it**, in a PR of its own, never in the same PR as the change that was
  failing. Tightening a number is quiet. Loosening one is loud: the PR says which number, from what,
  to what, and why.
- The requirement each row serves is in [`docs/requirements/spec.md`](docs/requirements/spec.md).
  Its baseline qualities BASE-01–05 are Musts that apply to every item (see
  [`moscow.md`](docs/requirements/moscow.md)).

**Status on 7 Nov 2026:** written only. There is no code, CI or test runner yet. Each row names the
issue that turns it into a check. Until those land, review enforces the floor.

## Floor (always enforced)

Checked in the diff against the merge base by the floor guard (#40), adapted from
[`floor-guard.md`](.agents/skills/constraint-driven-development/references/floor-guard.md). It
reports the rule and the location, never a matched value.

- No new suppression comments: `@ts-ignore`, `@ts-expect-error` without a reason, `eslint-disable`,
  `biome-ignore`, `istanbul ignore`, `c8 ignore`, `Stryker disable`, `nosemgrep`,
  `gitleaks:allow`, `# noqa`, `# type: ignore`.
- No unimplemented stubs: `throw new Error("Not implemented")`, an empty `catch {}`, a `TODO`
  standing in for the implementation.
- No skipped, focused or deleted tests (`.skip`, `.only`, `.todo`, a removed test file, assertions
  removed from a test that stayed) without a reason in the commit message.
- No secrets in source. Read them from env vars and keep placeholders in `.env.example`.
- This file isn't weakened to make a change pass.

## Enforced with numbers

All rows block, except where _warn_ is noted. "Runs at" uses the stages under [Stages](#stages).

| Dimension | Rule | Why this number | Checked by | Runs at | Enforced by |
|---|---|---|---|---|---|
| Types | 0 type errors | Any error is a bug or a lie | `tsc --noEmit` | edit, CI | #40 |
| Lint | 0 errors from the project config | The config is the standard; a warning nobody fixes is noise | ESLint or Biome (decided in #40) | edit, CI | #40 |
| Coverage: `packages/sim` | Changed lines ≥ 90% covered | The sim is the research contribution, and a pure module with no I/O is cheap to cover | Vitest coverage lcov ∩ `git diff` | task end, CI | #40 |
| Coverage: everything else | Changed lines ≥ 80% covered | High enough to force a test, low enough to allow a config line | Vitest coverage lcov ∩ `git diff` | task end, CI | #40 |
| Boundaries (MUST-10.1) | 0 violations: `packages/sim` imports nothing outside itself and no `node:*`, and calls no `Date.now()` or `Math.random()`; client code never imports `apps/web/src/server/` | The determinism claim depends on it, and the spec asks for a check, not review | Fallow boundaries | edit, CI | #41 |
| Sim speed | `advance()` across 30 days on the largest content farm ≤ 50 ms median; `apply()` ≤ 1 ms median | Offline catch-up runs inside a request with a 300 ms p95 budget (BASE-04), so the sim may use at most a sixth of it | sim benchmark, farm read from content data | task end, CI | #41 |
| Assertion strength _(warn)_ | Mutation score ≥ 60% on changed `packages/sim` files | Typical for a suite never mutated before (80% is mature). It answers "the agent wrote the tests too" | Stryker `--mutate <changed files>` | CI | #41 |
| Secrets | 0 findings | Any finding is a leak | `gitleaks detect --redact --no-banner` | CI | #42 |
| Dependencies | Nothing at high or above | Below high is mostly noise | `osv-scanner scan source -r .` | CI | #42 |
| Code security | 0 high findings | Matches the OWASP mapping in MUST-16 | `semgrep scan --config p/default --config p/owasp-top-ten` on changed files | CI | #42 |
| Page performance | Lighthouse mobile: LCP ≤ 2500 ms, CLS ≤ 0.1, TBT ≤ 200 ms | Core Web Vitals "good". Lab tests can't measure INP, so TBT stands in for it | Lighthouse against the Vercel preview | preview | #43 |
| Accessibility (BASE-03) | 0 critical or serious violations | Moderate and minor findings are often debatable | axe-core, tags `wcag2a,wcag2aa,wcag21aa,wcag22aa`, against the preview | preview | #43 |
| Action latency (BASE-04) | p95 < 300 ms on the deployed stack | Already in the spec | `Server-Timing` totals (MUST-19.1) from a scripted run against the preview; at load, SHOULD-03 | preview, gate | #43 |
| Browsers and widths (BASE-02) | Latest 2 Chrome, Firefox and Safari; desktop and 360 px | Already in the spec | browser tests (tool decided in #44) | CI | #44 → follow-up |
| Prediction (BASE-05) | Shows ≤ 100 ms after a tap (MUST-12.1) | Already in the spec | browser timing test (tool decided in #44) | CI | #44 → follow-up |

**External opinions.** gitleaks, osv-scanner, Semgrep, axe and Lighthouse judge the code by rules
this project didn't write, so an agent can't make them pass with code that doesn't work. The
coverage and mutation rows measure the project's own tests, and Stryker is the check on those
tests.

**Timing checks.** CI runners are shared, so one timing can swing by tens of percent between runs
of the same code. A check that fails at random teaches everyone to rerun until it's green, so the
timing rows (sim speed, page performance, action latency) never judge a single measurement:

- The sim benchmark runs warm-up iterations, then at least 5 measured runs, and compares the
  median with the budget.
- Lighthouse runs at least 3 times against the preview and compares the median run with the
  budget.
- The latency smoke compares the p95 over the whole scripted run, never a single request.
- If a median is over budget, the job measures once more and fails only if both medians are over.
  Retrying by hand until the check is green counts as weakening the bar.
- If a timing check still fails on unchanged code (a rerun of `main` goes red), that's a flaky
  check. Fix the measurement in its own PR rather than moving the threshold.

## Measured, not yet enforced (ratchets)

No honest number exists before the code does. Each ratchet records today's value, then refuses to
get worse. When the number improves, update it here. When it drops past the tolerance, that's the
finding.

| Metric | Today | Direction | Tolerance | Recorded by |
|---|---|---|---|---|
| Project coverage | not yet: recorded after the first `packages/sim` PR | must not fall | 0.5 points | #40 |
| First-load JS of the game route | not yet: recorded at the first preview deploy | must not grow | 5% per PR | #43 |

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
| After each edit | `pnpm check:fast` (agent hook, proposed in #40) | Types and lint on changed files, floor guard, boundaries | under 5 s |
| Task end, before the agent opens a PR | `pnpm check:task` | `check:fast`, plus related unit and property tests (fixed seed, capped runs), coverage of changed lines, sim benchmark | ≤ 90 s |
| Every PR | CI (`pnpm check:full` + scan jobs) | Everything above, plus larger property runs, gitleaks, osv-scanner, Semgrep, Stryker _(warn)_, acceptance tests (MUST-17.1) | unlimited |
| Every preview deploy | CI against the Vercel preview | Lighthouse, axe, bundle ratchet, latency smoke | unlimited |
| Milestone gate | the admin | [Checked by review](#checked-by-review), BASE-04 from the metrics | n/a |

Each blocking CI job is a required status check on `main`. The ruleset comes from ADR-0002
(PR #35).

## Guarding the bar

At review, compare the diff against the merge base for the five ways a bar gets lowered:

1. **A threshold moved**: a number in this file lowered, a severity dropped, a check moved to a
   later stage or removed.
2. **A test got easier**: `.skip` or `.only` added, a test file deleted, assertions removed from a
   test that stayed, a property's run count cut.
3. **A checker was silenced**: any suppression from the [Floor](#floor-always-enforced) list.
   `istanbul ignore`, `Stryker disable`, `nosemgrep` and `gitleaks:allow` deserve extra attention:
   they switch off a check this file relies on.
4. **Work is unfinished**: a stub that throws, an empty `catch`, a `TODO` where the implementation
   should be.
5. **An exception appeared**: a new row below that nobody discussed.

The floor guard (#40) catches 2–4 mechanically. 1 and 5 are changes to this file, which only the
admin makes.

## Exceptions

An exception unblocks one rule on one path for a limited time. It needs an owner, a reason and an
expiry no more than 30 days out and never past the feature freeze on 20 Dec 2026. 90 days, the
usual default, would outlive the project. Only the admin adds a row.

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
