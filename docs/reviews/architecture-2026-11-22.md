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

## Candidates: `packages/sim`

### A1. One owned-entry list for facilities and pens. Strong, #541

- **Files:** `facilities/index.ts:465-528` (`findRule`, `findOwned`, `readEntry`, `replaceFacility`,
  `formatFacilityNumber`) and `pens/index.ts:79-90, 194-229` (`buyPen`, `findRule`, `findOwned`,
  `describeNoPen`, `replacePen`).
- **Problem:** both features keep "one entry per content item, null until bought", and each writes
  its own copy. The copies have drifted:
  - `readEntry` treats a missing facility entry as a broken farm and throws a `RangeError` (ADR-0003
    section 4, D15).
  - `pens/` reads `farm.pens[index] ?? null` and treats a missing entry as "not bought".
  - On a farm whose `pens` array is shorter than content, `buyPen` charges the price through
    `purchase`. Then `replacePen`'s `map` drops the new pen, so the coins are spent and no pen
    appears.
  - Facilities prints "facility 0" for index −1, and pens doesn't.
- **Solution:** one sim module for the owned-entry list. It owns the lookup by index, the
  broken-farm throw, the "isn't bought" and "already bought" refusals, buy-once and replace.
  Facilities and pens call it.
- **Deletion test:** deleting it would bring the duplication back in both features, so it earns its
  keep.
- **Benefits:**
  - Locality: the D15 invariant lives in one place and is tested once.
  - Leverage: the next bought-once kind gets it for free.
  - Tests: one test through `apply` covers both features.

```
before                                   after
facilities/ ─ findOwned ─ readEntry(throw)    facilities/ ─┐
pens/       ─ findOwned ─ ?? null (refuse)    pens/       ─┴─ owned-entry list (throw, refuse, buy, replace)
```

### A2. Features own their unlock Levels. Strong, #542

- **Files:** `progress/index.ts:8-37` (`ProgressRules`), read from `facilities/index.ts:73-78`,
  `pens/index.ts:57`, `orders/index.ts:67, 180` and `plots/` (`cropLocked`).
- **Problem:** `ProgressRules` exposes one raw unlock map per kind of thing. Every feature that adds
  an unlockable kind widens `progress/`'s interface, which is why `progress/index.ts` and
  `src/index.ts` change together in half their commits. Access is uneven too: tiers go through
  `findTierLevel`, and the rest are read as raw maps.
- **Solution:** `progress/` keeps Levels, `levelOf`, `gainXp`, `purchase` and one way to read "the
  first Level listing this id" and its locked sentence. Each feature derives its own unlock Levels
  when `createSim` prepares its rules.
- **Deletion test:** the maps are pass-throughs. Deleting them moves one line into each feature, so
  the complexity stays where it belongs.
- **Benefits:**
  - Locality: `progress/` stops changing with every feature.
  - Leverage: one locked-reason read replaces `cropLocked` and its siblings.
- **ADR:** fits ADR-0003 section 11 (a derived Level and one purchase rule). The section is updated,
  not contradicted.

### A3. A feature descriptor: one registration point per feature. Worth exploring

- **Files:**
  - `sim/index.ts:79-86` (step sources), `:89-102` (`newFarm`) and `:120-143` (`applyAction`'s
    `switch`).
  - `state/index.ts:10-41` (the `FarmState` field and the `Action` union) and `src/index.ts`.
  - `progress/index.ts:8-23`.
  - `state/tests/farms.ts:84-109`, `sim/tests/advance.bench.ts` and `properties.test.ts:826-1003`.
- **Problem:** #84 to #88 each touched every one of these files, so "a feature" has an interface
  only by convention. That explains two of Fallow's hidden couplings (A2's, and `farms.ts` ↔
  `advance.bench.ts`).
- **Solution:** each feature module exports one descriptor with these parts:
  - how it prepares its rules,
  - its slice of a new farm,
  - its action handlers keyed by action type,
  - its step sources.

  `createSim` folds over the list, and dispatch becomes a lookup. Typing the handlers as a mapped
  type over `Action["type"]` keeps the `Action` union and the exhaustive check.

- **Deletion test:** today `sim/index.ts` is mostly pass-through wiring. The descriptor would earn
  its keep: `newFarm`, dispatch and sources come for free.
- **Why not Strong:** it reshapes the sim's main module and every feature's export, which is an
  Interface-change PR. It also lands better after #535 and #539 (the registry and versioned replay)
  settle how `createSim` is called per rules version. The admin should judge whether the next sim
  feature is far enough off to make it worth it now.
- **ADR:** ADR-0005 section 3 gives `sim/` "dispatching actions", and this keeps it there.
  ADR-0003's Patterns table already uses the same Strategy shape for step sources.

### A4. A seam for "the action alone". Worth exploring

- **Files:** `properties.test.ts:210-250` (`actAlone`) and `:826-1003` (the oracle arrow at :831,
  cyclomatic 73).
- **Problem:** `apply` always runs the automated steps an action makes due. To see the bare action,
  the test does all of this:
  - turns every add-on off,
  - re-applies the action,
  - merges the flags back,
  - writes `buyAddOn` out by hand.

  The oracle is a hand-written expectation per action type in one long `if` chain. Its complexity
  comes from listing 13 actions, not from tangled logic.

- **Solution:** let the property tests import the dispatch as an internal module (not through
  `src/index.ts`), and split the oracle into a table of per-action expectation functions. This falls
  out of A3's keying.
- **Deletion test:** `actAlone` would vanish entirely, which shows it's a workaround, not a module.
- **Tension:** `code-style.md` puts the property harness behind the package entry ("so it tests what
  `apps/web` calls"). This candidate would add one internal import, and the admin decides.

### A5. "Producible" asked of each feature. Speculative

`orders/index.ts:161-204` switches on crop, facility and pen, and reads `farm.facilities[i].tier`
and `farm.pens[i]` directly. The test's copy (`properties.test.ts:318-325`) ignores tiers. The
complexity is real but small, and it only pays once there are more producers. If done, it changes
where ADR-0003 section 15's single source of truth sits, not what it says.

### Checked and fine (`packages/sim`)

- `advance/` is deep. Its step ranks sit in one place on purpose (ADR-0003 sections 2 and 12).
- `storage/` (`put`, `take`, `countStored`) and `progress/`'s `purchase` are small interfaces with
  real behaviour behind them.
- `state/`'s fan-in of 12 is mostly `refuse` and `ApplyResult`, which is expected.
- `canonicalJson`'s `write` is a plain type dispatch.
- The bench builds its farm from content data.

## Candidates: `apps/web`

### B1. A seam in the composition root. Strong, #543

- **Files:** `server/api/index.ts:45-58` (`createApi`'s `connect` builds `createStore` and
  `createAuth` directly), `api/tests/getApi.test.ts:18-38` and `api/tests/api.test.ts:10-20`.
- **Problem:** the composition root has no seam, so its tests reach past the interface:
  - `getApi.test.ts` mocks `@/server/auth` and `@/server/store` with `vi.mock`, and calls
    `getApi()`. ADR-0007 section 2 says tests never do that ("Tests build `deps` themselves and
    never call `getApi()`").
  - `api.test.ts` mocks `@supabase/supabase-js` to count clients.
  - The contract-500 assertion is copied four times (Fallow).
- **Solution:** `createApi` takes the connection builder as a dependency, and `getApi` passes the
  real config → db → store → auth chain. Tests pass the in-memory store, which the store contract
  already holds to B100, and a fixed player.
- **Deletion test:** `memoise(connect)` earns its keep. The module mocks are pure overhead, and they
  go.
- **Benefits:**
  - Locality: the wiring is tested through its own interface.
  - Leverage: one shared contract-500 helper.
  - The code matches ADR-0007 section 2 again.

```
before                                      after
api.test ──vi.mock──▶ store, auth, supabase   api.test ──createApi(connect = memory store)──▶ api
getApi.test ──getApi()──▶ (mocked modules)    getApi() = createApi(realConnect)   (one test)
```

### B2. The rules version owned once. Resolved by #529

At `da2c67c`, the store stamped its own `rulesVersion = 1` (`store/index.ts:97-102`) while the rules
module held another, so the store wrote a version it was never given. #443 (merged as #529,
`9e99165`) now passes `rulesVersion` from the rules module through `StoreDeps`. Nothing is filed. B3
is what remains here.

### B3. One "snapshot + rows → farm" fold for both store adapters. Worth exploring

- **Files:** `store/index.ts:113-137` (B100) and `store/tests/memoryStore.ts:43-59` (the in-memory
  adapter).
- **Problem:** both adapters re-implement the same fold:
  - a new farm at seq 0, otherwise the newest snapshot;
  - then the rows replayed up to the last row's time.

  The fake picks its snapshot by `rows.length` arithmetic. The rules-version tie-break exists only
  in B100. The contract suite catches only the drift it tests for.

- **Solution:** a pure fold inside `store/` that both adapters call, so each adapter only fetches
  rows.
- **Deletion test:** it earns its keep, since the logic currently lives in two adapters.
- **Why not Strong:** #535 wires #154's versioned `replay` into the store and will reshape exactly
  this fold. Fold this candidate into #535's design rather than racing it.

### B4. One request pipeline instead of an `Api` that grows per route. Worth exploring

- **Files:** `api/index.ts:14-23` ("Each game ticket adds its entry here") and
  `api/farmRoutes.ts:53-92, 106-133`.
- **Problem:**
  - Each handler re-states the order: 401, then the checks, then the call into `game/`. The query
    check sits at a different point in each (lines 60 and 78).
  - `Api.readPlayer` is called by no route.
  - Every new route widens `Api`, `FarmRoutes`, its `route.ts` and the tests.
- **Solution:** `respond` becomes the deep module. It owns auth, connect, timing, error mapping and
  the order of checks. A route supplies only its own check and its call into `game/`. The rate limit
  (#340) then lands once.
- **Why not Strong:** with two routes this is a hypothetical seam. It becomes real with the next
  route (#338, #340, #341), so do it as the first step of whichever lands first.

### B5. Timing as a decorator over the store. Speculative

ADR-0007's Patterns table calls `timing/` a Decorator that "times a step without editing it". In
practice `game/` calls `withTiming` and knows the phase names
(`game/index.ts:93, 117, 200, 219-229`), and `GameDeps` is rebuilt per request for it
(`farmRoutes.ts:19, 122`). Wrapping the store per request would match the ADR. The deletion test is
neutral, since it moves knowledge rather than removing it, so the payoff is low.

### Checked and fine (`apps/web`)

- The store has two real adapters, and `describeGameStore` runs through `GameStore` on both, so this
  is a real seam.
- Each `route.ts` is a humble object.
- `http/` is deep: a closed error-code set, one builder and a status table.
- `auth/` hides the JWKS fetch and the claim checks behind one function.
- `game/` earns its keep (retry, resend and the race re-check).
- `memoise` is small but justified.
- `SubmitRequest` duplicating `ActionRequest` is a consequence of the zone rules, and harmless.

## Candidates: `scripts/` and `.github/scripts/`

No module owns "talk to GitHub" on the bash side, by design. 18 non-test scripts in `scripts/` and
`scripts/setup/` hard-code the repo, and 18 define their own `die`. A shared library for that would
be a pass-through, so it isn't a candidate. The candidates are the places where the same rule is
written more than once and the copies disagree.

### C1. One module for the lane rules. Strong, #544

- **Files:** `scripts/open-pr.sh:98-106` (the `--as-admin` path re-implements "the workflow's
  refusals"), `.github/scripts/open-pr.sh:27-39`, `.github/scripts/pr-draft.sh:21` and
  `scripts/board-status.sh:228` (a looser parser).
- **Problem:** the lane-branch regex, the title and body limits and the label check are written four
  times. The copies have drifted: the workflow refuses dot-only branch and label names
  (`dots_only`), and the `--as-admin` path doesn't. These rules are the gate on who opens which PR,
  so the drift matters.
- **Solution:** one sourced shell module for the lane rules, used by both the request side and the
  workflow side, with one test.
- **Deletion test:** it earns its keep, by removing three or four copies that already disagree.
- **Admin review:** touches `.github/`, so `review:admin`. Coordinate with #405.

### C2. A guard runtime beside `diff.mjs`. Strong, #545

- **Files:**
  - The CLI-wrapper clone group: `coverage-gate.mjs:161-175`, `floor-guard.mjs:1832-1845`,
    `pr-body-guard.mjs:102-113`, `skill-proof.mjs:126-140`, `typecheck-reach.mjs:96-110` and
    `unticked-boxes.mjs:98-109`.
  - The REST clients: `acceptance-guard.mjs:54-75`, `code-owned-guard.mjs:189-213` and
    `stack-base-guard.mjs:102-112`.
- **Problem:**
  - `diff.mjs` (fan-in 13) mixes diff parsing with the guards' runtime (`CannotRun`, `isMain`,
    `readEvent`).
  - What isn't in it is copied: the 0/1/2 exit-code wrapper six times, and a REST client three
    times.
  - The REST copies have drifted: `stack-base-guard.mjs` ignores `GITHUB_API_URL` and doesn't
    paginate.
- **Solution:** a guard-runtime module holding the CLI wrapper, the event reader and one REST
  client. `diff.mjs` keeps only the diff code.
- **Seam:** the guards already take their GitHub reads as injected functions. That seam has two
  adapters (production fetch and the test fakes), so it's real, and only the production adapter
  moves.
- **Deletion test:** the REST client earns its keep. The wrapper alone is shallow, but it enforces
  the exit-code contract across six callers.
- **Benefits:** it clears four of Fallow's clone groups in `.github/scripts` (the two wrapper groups
  and the two REST groups), likely the six test-fixture groups between the two guards' tests, and
  gives #530's split a runtime to use.
- **Sequencing:** land it before or after #530, not alongside: both edit `floor-guard.mjs`'s entry
  point. `review:admin`.

### C3. One dispatch-and-wait module. Strong, #546

`scripts/open-pr.sh:174-215` and `scripts/pr-draft.sh:62-90` each do the same four things:

1. read the newest run id before sending;
2. POST `dispatches`;
3. find the run by `display_title` with the same `run_state` jq;
4. poll with their own timeout variables.

The race guard (never taking an older run as this dispatch's answer) is the subtle part, and it is
written twice. One `scripts/lib/` module, tested through `gh-fake.sh`'s `POST dispatches`, puts a
fix to run matching in one place.

### C4. `project-rest.sh` deepened into the one Project reader. Strong, #547

- **Files:** `scripts/lib/project-rest.sh` (47 lines of constants and jq), and its callers
  `scripts/missing-fields.sh:72-97`, `scripts/today-gather.sh:118-141` and
  `scripts/issue-fields.sh:196-207`.
- **Problem:** each caller repeats the same protocol:
  - a temp file for gh's errors;
  - fields, then a name-to-id map, then an id check;
  - the paged items;
  - the proxy's 403 (`project_refused`), then a flag of its own.

  The tests fake the 403 twice, under different flag files.

- **Solution:** one reader. Given field names, it returns rows or says "refused". Callers keep only
  their row shape.
- **Deletion test:** today deleting `project-rest.sh` loses only constants, so it is a near
  pass-through. After the change it would earn its keep.
- **Sequencing:** after #406, which moves two of the callers.

### C5. The inline `gh` fakes moved onto `gh-rest-fake.sh`. Worth exploring

- **Problem:** 11 suites write their own `bin/gh` heredoc, about 325 lines in all:
  `today-gather.test.sh:32-88`, `setup/ci-check.test.sh`, `backfill-issue-types.test.sh`,
  `ci-cost.test.sh` and others. `today-gather`'s fake re-implements `gh-rest-fake.sh`, including the
  proxy's 403 wording.
- **Overlap:** #547 moves that one suite. The rest are lower value: each fake fits its suite, and
  `gh-fake.sh` (stateful PRs and stacks) is a separate, justified adapter.

### C6. Closing keywords encoded once. Speculative

GitHub's nine closing keywords are written in jq (`board-status.sh:121-124`) and in JS
(`pr-body-guard.mjs:20`). It's small, and #512 (the foreign-keyword check) is about to touch the JS
side, so it's left to that issue.

### Checked and fine (scripts)

- REST throughout, on purpose. The only GraphQL is documented.
- `pr-title.sh` and `issue-types.sh` are deep enough and shared correctly.
- `stack.sh` → `open-pr.sh` → `pr-draft.sh` are layered through each other's command lines, not
  copied.
- `board-status.sh move` delegates to `issue-fields.sh`.
- Churn in `scripts/` is low (`stack.sh` 8 commits, `issue-fields.sh` 6), so these candidates are
  about drift, not hotspots.

## ADR conflicts

No candidate contradicts an ADR. Two bring the code back in line with one:

- **B1:** ADR-0007 section 2 says tests never call `getApi()`, and today one does.
- **B5:** ADR-0007's Patterns table calls `timing/` a Decorator.

One touches a standard rather than an ADR:

- **A4:** `code-style.md` puts the property harness behind the package entry. A4 would add one
  internal import, and the admin decides.

## How this review was run

1. Read #407, `GLOSSARY.md`, ADR-0003, ADR-0005 and ADR-0007, `docs/agents/code-style.md` and the
   `improve-codebase-architecture` and `codebase-design` skills.
2. Ran Fallow on a full clone (above), and walked `git log` for hot spots. Since 1 Nov, the most
   changed files in scope are `properties.test.ts` (19 commits), `content/index.ts` (18),
   `sim/index.ts` (15), `src/index.ts` (13) and `state/tests/farms.ts` (11).
3. Three read-only sub-agents walked `packages/sim`, `apps/web` and `scripts/` with the Fallow
   output and the list of open work. Each claim kept here was checked against the code:
   - A1: `pens/index.ts:82, 89` against `facilities/index.ts:499-506`.
   - B1: `api/index.ts:45-58`, the `vi.mock` lines, and ADR-0007 line 147.
   - B3: both `load` implementations.
   - C1: the three `LANE=` lines and `dots_only`.
   - C2: the `GITHUB_API_URL` and pagination grep.
   - C3: the two `run_state` definitions.
4. Filed the Strong candidates (#541–#547) with `scripts/new-issue.sh`. Each exited 4: filed with
   its labels, milestone, type and parent, and with `triage` because the Project can't be reached
   from the cloud.

The skill's HTML report and its grilling loop are for an interactive session. This run was
unattended, so the report is this Markdown file and the admin picks from the filed issues.
