# Architecture review, M3 (2026-11-22)

The M3 architecture review (#407): the `improve-codebase-architecture` skill over `packages/sim`,
`apps/web` and `scripts/`, fed by Fallow's hotspots, duplication and cycles. `.github/scripts/` is
in too, because most of Fallow's findings sit there. The vocabulary is the `codebase-design` skill's
(module, interface, depth, seam, adapter, leverage, locality) and `GLOSSARY.md`'s.

- **Code reviewed:** `main` at `da2c67c`. Line references are at that commit. Before this report's
  PR opened, `main` moved to `3f78561`. In the reviewed paths that added #529 (the store takes the
  rules version, which settles B2) and #526 (`acceptance-guard.mjs` pages its file list). Neither
  changes another candidate.
- **Tool:** Fallow 3.43.1 (`pnpm exec fallow`, config `.fallowrc.jsonc`), run on a full clone
  (`git fetch --unshallow`; on the shallow clone, hotspots saw only 6 files).
- **What filing means:** each candidate rated **Strong** is filed in Backlog with
  `scripts/new-issue.sh`, in M5 with `triage` (the cloud can't reach the Project). Each issue is a
  proposal, and the admin decides at Ready. The other candidates are recorded here and not filed.

## Summary

<!-- prettier-ignore -->
| ID | Candidate | Strength | Effort | Payoff | Issue | Open work it touches |
|---|---|---|---|---|---|---|
| A1 | One owned-entry list for facilities and pens (copies have drifted: `buyPen` latent bug) | Strong | S | med | #541 | none |
| A2 | Features own their unlock Levels; `progress/` stops holding a map per kind | Strong | S | med | #542 | none |
| A3 | A feature descriptor: one registration point per sim feature | Worth exploring | M | high | — | #535, #539 (sim wiring) |
| A4 | A seam for "the action alone"; the property oracle as a table | Worth exploring | S–M | med | — | none; follows A3 |
| A5 | "Producible" asked of each feature instead of read by `orders/` | Speculative | M | low | — | none |
| B1 | A seam in the composition root, so `api/` tests stop mocking modules | Strong | S | med | #543 | none |
| B2 | The rules version owned once | (resolved) | — | — | #443, merged as #529 | — |
| B3 | One "snapshot + rows → farm" fold for both store adapters | Worth exploring | S–M | med→high | — | #535 (registry into the store) |
| B4 | One request pipeline (`respond`) instead of an `Api` that grows per route | Worth exploring | M | med | — | #338, #340, #341 |
| B5 | Timing as a decorator over the store, as ADR-0007's Patterns table says | Speculative | S | low | — | none |
| C1 | One module for the lane rules (four copies, drifted) | Strong | S | med–high | #544 | #405 |
| C2 | A guard runtime beside `diff.mjs` (CLI exit codes, event, REST client) | Strong | S–M | med | #545 | #530, #503 |
| C3 | One dispatch-and-wait module for `open-pr.sh` and `pr-draft.sh` | Strong | S–M | med | #546 | none |
| C4 | `project-rest.sh` deepened into the one Project reader | Strong | M | med–high | #547 | #406 (sequence after it) |
| C5 | The inline `gh` fakes moved onto `gh-rest-fake.sh` | Worth exploring | M | med | — | partly in #547 |
| C6 | GitHub's closing keywords encoded once | Speculative | S | low | — | #512 |

**Top recommendation: A1 (#541).** It's the one candidate where duplication has already become a
wrong result in the rules, which are the research contribution. It's small (S), and a test through
`apply` proves it. A2 (#542) is the natural follow-on in the same lane. Of the rest, B1 (#543) has
the best payoff for its size: it removes the module mocks that contradict ADR-0007 section 2.

**M3's open work (#373, #382, #383, #393–#397):** all closed at the time of review, so no candidate
can collide with them. The "Open work it touches" column lists the open issues and PRs that each
candidate does touch instead.

**The #290 safeguard** ("`/today` or the Sunday retro flags the week's architecture review when it
hasn't run") is already filed as #517. That issue goes further: on `milestone: created`, a workflow
files "Architecture review, <milestone>" into each new milestone, so the review becomes a ticket
instead of a calendar slot (admin, grill of 22 Nov). It also retitles #407 as M3's review. Nothing
new is filed for it here.

## Fallow's findings

Each command was run from the repo root on `da2c67c`, with the exit code noted. Shell scripts are
outside Fallow's reach (it reads JS and TS only), so `scripts/` was reviewed by reading it.

### Hotspots: `fallow health --hotspots --targets --top 30` (exit 0)

29,523 LOC · avg cyclomatic 1.7 · p90 3 · maintainability 91.7. The churn hotspots in the scoped
paths, by Fallow's score:

<!-- prettier-ignore -->
| Score | File | Commits | Churn | Trend |
|---|---|---|---|---|
| 98.9 | `.github/scripts/floor-guard.mjs` | 21 | 4549 | cooling |
| 64.7 | `packages/sim/src/sim/tests/properties.test.ts` | 19 | 1640 | cooling |
| 22.4 | `packages/sim/src/sim/index.ts` | 15 | 257 | cooling |
| 18.8 | `packages/sim/src/facilities/index.ts` | 9 | 675 | stable |
| 15.3 | `packages/sim/src/progress/index.ts` | 7 | 159 | cooling |
| 14.8 | `.github/scripts/coverage-gate.mjs` | 5 | 413 | cooling |
| 13.6 | `.github/scripts/diff.mjs` (fan-in 13) | 4 | 342 | stable |
| 13.4 | `packages/sim/src/state/index.ts` (fan-in 12) | 9 | 127 | accelerating |
| 6.4 | `apps/web/src/server/api/index.ts` (fan-in 8) | 6 | 140 | stable |

Hidden change coupling (files that change together with no import between them):

- `packages/sim/src/index.ts` ↔ `progress/index.ts`, 50% → A2, A3.
- `sim/tests/advance.bench.ts` ↔ `state/tests/farms.ts`, 74% → A3.
- `advance/tests/index.test.ts` ↔ `sim/index.ts`, 45% → the step ranks are deliberately in one place
  (ADR-0003 section 2), so this one is fine.
- The `hash/`, `random/` and `state/` `index.test.ts` trio, 100% → only repo-wide refactor commits
  (#125, #200, #213), so no design signal.

Fallow's refactoring targets: `floor-guard.mjs` (already #530), `progress/index.ts` (A2),
`properties.test.ts` (A4), `diff.mjs` (C2) and `coverage-gate.mjs` `evaluate` (C2's runtime takes
its CLI part).

### Complexity: `fallow health --complexity` (exit 1: 35 functions over the defaults)

There are 22 in `.github/scripts`, 13 in `packages/sim` and 0 in `apps/web`. Outside
`floor-guard.mjs` (#530), the worst are:

- `properties.test.ts:831`, an arrow at cyclomatic 73 / cognitive 58 → A4.
- `diff.mjs:71`, `parseDiff`, at 24 / 33 → C2.
- `coverage-gate.mjs:66`, `evaluate`, at 18 / 31 → C2.
- `sim/index.ts:113`, `applyAction`, at 14 / 1, the action `switch` → A3.
- `hash/canonicalJson.ts:13`, `write`, at 13 / 15, a plain type dispatch, so fine.

### Duplication: `fallow dupes` (exit 0, reports only)

31 clone groups and 648 duplicated lines (2.2%). By instances, 59 are in `.github/scripts` and 13 in
`apps/web`, with none in `packages/sim` (the sim's dupes check gates it).

- **A 12–15 line CLI wrapper** appears in six guards → C2.
- **A 20-line event-to-REST block** appears in `acceptance-guard`, `code-owned-guard` and
  `stack-base-guard` → C2.
- **Six groups** sit between `acceptance-guard.test.mjs` and `code-owned-guard.test.mjs` → C2.
- **The contract-500 assertion block** is repeated across `getApi.test.ts`, `api.test.ts` and
  `farmRoutes.test.ts` → B1.
- **Repeated setup in `game.test.ts`** (97–105 ×3, 183–193 / 201–209) is a seed helper, not a design
  issue.
- **`store/schema.ts:34-40` / `62-68`** are two tables with parallel columns, which is fine.

### Cycles and boundaries: `fallow architecture` and `fallow architecture --cycles` (exit 0)

"No issues found": no import cycles, and every boundary rule in `.fallowrc.jsonc` holds.

## Candidates

Each Strong candidate is summarised here; its issue holds the scope and acceptance criteria.

### `packages/sim`

**A1. One owned-entry list for facilities and pens. Strong, #541.**

- **Files:** `facilities/index.ts:465-528` (`findRule`, `findOwned`, `readEntry`, `replaceFacility`)
  and `pens/index.ts:79-90, 194-229` (`buyPen`, `findOwned`, `replacePen`).
- **Problem:** both features keep "one entry per content item, null until bought", each in its own
  copy, and the copies have drifted. `facilities/` throws a `RangeError` on a missing entry (a
  broken farm, ADR-0003 section 4, D15); `pens/` reads `farm.pens[index] ?? null` as "not bought".
  On a farm whose `pens` array is shorter than content, `buyPen` charges the price through
  `purchase`, then `replacePen`'s `map` drops the new pen: coins spent, no pen.
- **Solution:** one sim module owns the lookup, the broken-farm throw, the bought / not-bought
  refusals, buy-once and replace. Deletion test: removing it brings the duplication back in both
  features, so it earns its keep.
- **Benefits:** the D15 invariant has locality (one place, one test through `apply`), and the next
  bought-once kind gets it as leverage.

```
before                                        after
facilities/ ─ findOwned ─ readEntry (throw)   facilities/ ─┐
pens/       ─ findOwned ─ ?? null (refuse)    pens/       ─┴─ owned-entry list
```

**A2. Features own their unlock Levels. Strong, #542.** `ProgressRules` (`progress/index.ts:8-37`)
exposes one raw unlock map per kind, read by `facilities/` (:73-78), `pens/` (:57), `orders/` (:67,
:180) and `plots/` (`cropLocked`); tiers alone go through `findTierLevel`. Every new unlockable kind
widens `progress/`'s interface, which is why `progress/index.ts` and `src/index.ts` change together
(Fallow, 50%). `progress/` should keep Levels, `levelOf`, `gainXp`, `purchase` and one "first Level
listing this id" read; each feature derives its own unlock Levels in `createSim`. The maps are
pass-throughs, so deleting them only moves one line into each feature. It updates ADR-0003 section
11 rather than contradicting it.

**A3. A feature descriptor. Worth exploring.** #84 to #88 each touched the same nine places:
`sim/index.ts` (step sources :79-86, `newFarm` :89-102, `applyAction`'s `switch` :120-143),
`state/index.ts:10-41`, `src/index.ts`, `progress/`, `state/tests/farms.ts:84-109`,
`advance.bench.ts` and `properties.test.ts:826-1003`. "A feature" has an interface only by
convention, which explains two of Fallow's hidden couplings. Each feature could export one
descriptor (rules preparation, its slice of a new farm, handlers keyed by action type, step sources)
that `createSim` folds over, keeping the `Action` union and the exhaustive check through a mapped
type. Not Strong: it reshapes the sim's main module and every feature's export (an Interface-change
PR), and it lands better after #535 and #539 settle how `createSim` runs per rules version. ADR-0005
section 3 keeps dispatch in `sim/`, and ADR-0003 already uses this Strategy shape for step sources.

**A4. A seam for "the action alone". Worth exploring.** `apply` always runs the automated steps an
action makes due, so `properties.test.ts:210-250` (`actAlone`) turns every add-on off, re-applies,
merges the flags back and writes `buyAddOn` out by hand. The oracle at :831 (cyclomatic 73) is one
`if` chain over 13 action types. An internal import of the dispatch, plus a table of per-action
expectations (which falls out of A3), would delete `actAlone`. It bends `code-style.md`'s rule that
the property harness imports through the package entry, so that's the admin's call.

**A5. "Producible" asked of each feature. Speculative.** `orders/index.ts:161-204` switches on crop,
facility and pen and reads their state directly; the test's copy (`properties.test.ts:318-325`)
ignores tiers. Small, and it pays only once there are more producers.

**Checked and fine:** `advance/` is deep (its step ranks sit in one place on purpose, ADR-0003
sections 2 and 12); `storage/` and `progress/`'s `purchase` are small interfaces with real
behaviour; `state/`'s fan-in is `refuse` and `ApplyResult`; `canonicalJson`'s `write` is a plain
type dispatch.

### `apps/web`

**B1. A seam in the composition root. Strong, #543.**

- **Files:** `server/api/index.ts:45-58`, `api/tests/getApi.test.ts:18-38`,
  `api/tests/api.test.ts:10-20`.
- **Problem:** `createApi`'s `connect` builds `createStore` and `createAuth` directly, so the tests
  reach past the interface: `getApi.test.ts` mocks `@/server/auth` and `@/server/store` with
  `vi.mock` and calls `getApi()`, which ADR-0007 section 2 says tests never do; `api.test.ts` mocks
  `@supabase/supabase-js`. The contract-500 assertion is copied four times (Fallow).
- **Solution:** `createApi` takes the connection builder as a dependency; `getApi` passes the real
  config → db → store → auth chain, and tests pass the in-memory store (already held to B100 by the
  store contract) and a fixed player. Deletion test: `memoise(connect)` earns its keep; the module
  mocks are overhead and go.
- **Benefits:** the wiring is tested through its own interface (locality), one contract-500 helper
  (leverage), and the code matches ADR-0007 again.

**B2. The rules version owned once. Resolved.** At `da2c67c` the store stamped its own
`rulesVersion = 1` (`store/index.ts:97-102`). #443, merged as #529 (`9e99165`), now passes it from
the rules module through `StoreDeps`.

**B3. One "snapshot + rows → farm" fold for both store adapters. Worth exploring.**
`store/index.ts:113-137` (B100) and `store/tests/memoryStore.ts:43-59` each re-implement "new farm
at seq 0, else the newest snapshot, then the rows replayed to the last row's time"; the fake picks
its snapshot by `rows.length` arithmetic, and the rules-version tie-break exists only in B100. A
pure fold inside `store/` would leave each adapter only fetching rows. Not Strong: #535 wires the
versioned `replay` into exactly this fold, so it belongs in #535's design.

**B4. One request pipeline. Worth exploring.** Each handler in `api/farmRoutes.ts:53-92, 106-133`
re-states the order 401 → checks → `game/` (the query check sits at a different point in each), and
`Api.readPlayer` (`api/index.ts:14-23`) has no route caller. `respond` could own auth, connect,
timing, error mapping and the check order, so the rate limit (#340) lands once. With two routes it's
a hypothetical seam; do it as the first step of whichever of #338, #340, #341 lands first.

**B5. Timing as a decorator over the store. Speculative.** ADR-0007's Patterns table calls `timing/`
a Decorator, but `game/` calls `withTiming` and knows the phase names
(`game/index.ts:93, 117, 200, 219-229`). Wrapping the store per request would match the ADR; it
moves knowledge rather than removing it.

**Checked and fine:** the store has two real adapters, and `describeGameStore` runs on both; each
`route.ts` is a humble object; `http/` and `auth/` are deep; `game/` earns its keep (retry, resend,
race re-check); `SubmitRequest` duplicating `ActionRequest` follows from the zone rules.

### `scripts/` and `.github/scripts/`

No module owns "talk to GitHub" on the bash side: 18 non-test scripts hard-code the repo and 18
define their own `die`. A library for that would be a pass-through. The candidates are the rules
written more than once whose copies disagree.

**C1. One module for the lane rules. Strong, #544.** The lane-branch regex, title and body limits
and label check are in `scripts/open-pr.sh:98-106` (the `--as-admin` path),
`.github/scripts/open-pr.sh:27-39`, `.github/scripts/pr-draft.sh:21`, and looser in
`scripts/board-status.sh:228`. The workflow refuses dot-only names (`dots_only`); `--as-admin`
doesn't. One sourced module with one test removes copies that already disagree, on the gate for who
opens which PR. Touches `.github/` (`review:admin`); coordinate with #405.

**C2. A guard runtime beside `diff.mjs`. Strong, #545.**

- **Problem:** `diff.mjs` (fan-in 13) mixes diff parsing with the guards' runtime (`CannotRun`,
  `isMain`, `readEvent`). The rest is copied: the 0/1/2 exit-code wrapper in six files
  (`coverage-gate.mjs:161-175`, `floor-guard.mjs:1832-1845`, `pr-body-guard.mjs:102-113`,
  `skill-proof.mjs:126-140`, `typecheck-reach.mjs:96-110`, `unticked-boxes.mjs:98-109`) and a REST
  client in three (`acceptance-guard.mjs:54-75`, `code-owned-guard.mjs:189-213`,
  `stack-base-guard.mjs:102-112`). `stack-base-guard.mjs` ignores `GITHUB_API_URL` and doesn't
  paginate.
- **Solution:** one module with the wrapper, the event reader and one REST client. The guards
  already take their GitHub reads as injected functions (a real seam with two adapters), so only the
  production adapter moves. The wrapper alone is shallow; the REST client earns its keep.
- **Benefits:** clears four clone groups (likely the six test-fixture groups too) and gives #530's
  split a runtime. Land before or after #530, not alongside. `review:admin`.

**C3. One dispatch-and-wait module. Strong, #546.** `scripts/open-pr.sh:174-215` and
`scripts/pr-draft.sh:62-90` each read the newest run id, POST `dispatches`, find the run by
`display_title` with the same `run_state` jq, and poll. The race guard (never taking an older run as
this dispatch's answer) is the subtle part and is written twice; one `scripts/lib/` module tested
through `gh-fake.sh` fixes it in one place.

**C4. One Project reader. Strong, #547.** `scripts/lib/project-rest.sh` holds only constants, so
`missing-fields.sh:72-97`, `today-gather.sh:118-141` and `issue-fields.sh:196-207` each repeat the
protocol (fields → id map → paged items → the proxy's 403 → a flag of their own), and the tests fake
the 403 twice under different flag files. A reader that returns rows or "refused" leaves callers
only their row shape. Sequence after #406.

**C5. The inline `gh` fakes onto `gh-rest-fake.sh`. Worth exploring.** 11 suites write their own
`bin/gh` heredoc (about 325 lines); `today-gather`'s re-implements `gh-rest-fake.sh`, 403 included.
#547 moves that one; the others fit their suites.

**C6. Closing keywords encoded once. Speculative.** Written in jq (`board-status.sh:121-124`) and JS
(`pr-body-guard.mjs:20`); #512 is about to touch the JS side.

**Checked and fine:** REST throughout, with the only GraphQL documented; `pr-title.sh` and
`issue-types.sh` are deep enough and shared; `stack.sh` → `open-pr.sh` → `pr-draft.sh` layer through
command lines; `board-status.sh move` delegates to `issue-fields.sh`; churn in `scripts/` is low, so
these candidates are about drift, not hotspots.

## ADR conflicts

None contradicts an ADR. B1 and B5 bring the code back in line with ADR-0007 (section 2; the
Patterns table). A4 bends a `code-style.md` rule, for the admin to decide.

## How this review was run

1. Read #407, `GLOSSARY.md`, ADR-0003, ADR-0005, ADR-0007, `code-style.md` and the
   `improve-codebase-architecture` and `codebase-design` skills.
2. Ran Fallow on a full clone (above) and walked `git log`. Since 1 Nov the most changed files in
   scope are `properties.test.ts` (19 commits), `content/index.ts` (18), `sim/index.ts` (15),
   `src/index.ts` (13) and `state/tests/farms.ts` (11).
3. Three read-only sub-agents walked `packages/sim`, `apps/web` and `scripts/` with the Fallow
   output and the open work. Each claim kept here was checked against the code (A1:
   `pens/index.ts:82, 89` against `facilities/index.ts:499-506`; B1: the `vi.mock` lines and
   ADR-0007 line 147; B3: both `load`s; C1: the `LANE=` lines and `dots_only`; C2: the
   `GITHUB_API_URL` and pagination grep; C3: both `run_state`s).
4. Filed #541–#547 with `scripts/new-issue.sh` (each exit 4: labels, milestone, type and parent set,
   `triage` because the cloud can't reach the Project).

The skill's HTML report and grilling loop are for an interactive session; this run was unattended,
so the report is this file and the admin picks from the filed issues.
