---
status: accepted
---

# Rules versions: replay never crosses a version, and a base snapshot holds the upgraded farm

ADR-0001 chose store B100: a farm is the result of replaying its append-only action log from the
latest snapshot, and `replay` throws if the rules refuse a logged action. Content is tuned after
playtest 1 (grow times, prices, yields, XP), and under B100 tuning is a rules change: replayed
under today's content, an old harvest can be refused (the farm can't load) or a farm can rebuild
to a different farm (MUST-13.6), and every stored snapshot would disagree with its log
(MUST-16.3). ADR-0001 left this open; ADR-0003 kept every option open by making the rules a
function of content (`createSim(content)`, no version field in the state). This ADR chooses how
logs stay replayable, before M3 builds the log and snapshot schema (#74) and before the first
tuning after playtest 1.

## How this was decided

A grill on #31 with the admin, 11 Nov 2026, one question per turn; Q1–Q10 below are the
questions in the order they were settled, and the glossary terms were chosen at the end. An
adversarial review of the chosen design, against MUST-13.6, MUST-16.3, MUST-16.4, MUST-10 and
ADR-0001, then found eleven issues. Six are fixed in the sections below, four are accepted as
trade-offs ([Consequences](#consequences)), and one needed a new decision (Q10).

"Rules version", "snapshot", "base snapshot" and "upgrade" are used as `GLOSSARY.md` defines them.

## 1. A base snapshot per rules version (Q1)

Every log row and every snapshot records the rules version it was written under. A replay never
crosses a version inside the rules: when the log steps from version N to a later version, the farm
is **upgraded** at that seq (section 6) and the rest of the log is replayed under the later
version. The snapshot that holds the upgraded farm is the **base snapshot** of that version.

**Patterns:** Event Sourcing with versioned events and snapshots (as ADR-0001); Upcaster
(section 6); Registry of versions (section 2).

**Rejected:**

- **Each action replayed under its own version, without an upgrade step.** The state from v1
  becomes v2's input with no defined point where its shape changes, and the time between two
  actions belongs to neither version. It is the chosen design with the upgrade left implicit.
- **A migration that rewrites old logs.** It breaks the append-only log that ADR-0001 makes the
  source of truth, and it destroys the history an audit checks (T10).
- **Allowing only rules changes that never refuse an earlier valid action.** It can't hold for
  tuning (a longer grow time refuses an old harvest), and even an accepted replay can rebuild a
  different farm, which MUST-13.6 forbids.
- **An eager rewrite of every farm at deploy** (one of #31's options, "fresh snapshots for every
  farm"): see section 3.

## 2. A rules version is a sequential integer with frozen content (Q3)

The rules versions are 1, 2, 3 and so on. The sim keeps a **registry** that maps each version to
its content object and its `upgrade` from the previous version (section 6). The current version is
the highest one in the registry.

A version is **released** when it first reaches an environment whose farms persist (the first is
M3's deploy, at the latest playtest 1). From then on, its content is **frozen**: the registry
records `stateHash(content)` for every released version, and the rules-version check (section 10)
fails if a released version's content no longer hashes to it. A tuning therefore adds a new
version; it never edits a released one. Content that hasn't been released yet can change freely.

The state still carries no version field (ADR-0003, section 1): the version belongs to the log
row and the snapshot that store the state, not to the state.

**Pattern:** Registry (version → content and upgrade); content as data (MUST-10.4).

**Rejected:**

- **The content hash as the version.** It can't be forgotten, but it is 64 hex digits on every
  row, says nothing about order, and a reader can't tell versions apart.
- **A hand-bumped integer with no hash check.** An edit to a released version's content in place
  would pass unnoticed, which is exactly the failure MUST-13.6 names.

## 3. The base snapshot is written lazily, by the first commit after the release (Q2)

Nothing happens at deploy. `load` replays a farm under the versions its log records, then upgrades
it to the current version, unadvanced (section 5). When the handler commits the farm's first
action under the new version, the same transaction writes the action's row (tagged with the
current version) and the base snapshot: the upgraded farm at the previous seq, tagged with the
current version. A farm with no action before the release needs no base: it is `newFarm` under the
current version, and no snapshot is ever written at seq 0.

Reads still never write (ADR-0001). An inactive farm costs nothing until its player returns.

A base snapshot is a cache like every other snapshot. Each log row's version is the source of
truth (section 5), so if a base snapshot is missing, `load` rebuilds the same farm from the older
snapshot and the upgrade.

**Pattern:** lazy migration, on the next write (the lazy-offline-progress choice of ADR-0001
applied to versions).

**Rejected:**

- **An eager deploy job that writes a base for every farm.** Farms it hasn't reached still have to
  load, so it needs downtime or the lazy path as well, and its work grows with every farm ever
  created.
- **Writing the base on the first load.** It breaks ADR-0001's "reads never write".

## 4. The release gap is advanced under the new version (Q5)

The offline time between a farm's last action under version N and its first action under a later
version is advanced entirely under the later version. `load` returns the farm upgraded and
unadvanced at its last action, and the handler advances it to `at` as for any farm. No release
time is recorded anywhere, and the server's result matches what a client on the new version
predicts.

**Rejected:** advancing under N up to the release time, then under the new version. Every version
would need an activation server time, and a deploy isn't atomic across instances: an old instance
could advance a farm past the "release time" after a new one had served it.

## 5. How replay reads versions

`replay` (ADR-0001) takes the versions along with the rows:

1. Start from the newest snapshot at or before the target seq. At the same seq, the snapshot with
   the higher version wins. With no snapshot, start from `newFarm` under the version of the first
   log row.
2. For each later row, in seq order: if its version is higher than the farm's, upgrade the farm to
   it (section 6). Then advance to the row's `at` and apply the action, both under the row's
   version.
3. A row whose version is lower than the farm's is a corrupt log: `replay` throws a store error.
   A refused logged action throws, as in ADR-0001.
4. `load` ends by upgrading to the current version, unadvanced.

A version the running code doesn't know (higher than its current version) makes `load` throw a
store error. That is section 8's case.

## 6. An upgrade brings a farm to the next version's shape (Q7)

Each version after the first provides `upgrade(farm)`, which takes a farm in the previous version's
shape and returns one in its own. By default it fills new plots, facilities, pens and goods from
content and changes nothing else. A farm that skipped versions is upgraded one step at a time
(v1 → v2 → v3). The rules only ever see a farm in their own version's shape.

`upgrade` is part of the sim, under all of its rules (pure, integer-only, plain JSON), and it is
total: it never throws. A content change that would invalidate a stored fact (a cap lowered below
what the farm holds, a good removed) is handled explicitly in that version's `upgrade`, for
example by keeping the excess or converting it to coins, and that choice is part of the content
change's review. It keeps every fact both versions share (coins, XP, goods, running timers) unless
the version's `upgrade` says otherwise.

**Pattern:** Upcaster (event sourcing), chained one version at a time.

**Rejected:** tolerant reading with additive-only content (no upgrade; every rule treats a missing
entry as its default). The default handling would spread through every rule, and a removal or
rename could never ship.

## 7. Running timers keep their stored end time (Q6)

When a plot is planted, a job starts, a trough starts emptying or an order slot starts its refill
delay, the state stores the server time it ends, read from content once. Work in flight at a
release ends when the player was told it would; only work started under the new version uses its
durations. This is a state-shape rule for #82, #84, #86, #87 and #88, and it fits ADR-0003's
"facts are stored" (section 5).

**Rejected:** storing the start time and deriving the end from the current content. A tuning would
apply retroactively, and a crop the player saw nearly ripe could fall back.

## 8. Rules code reproduces every kept version (Q4), and versions only go forward (Q10)

`createSim(content)` keeps old content, not old code. So **the one sim must reproduce every
released version exactly**: a change to the rules code may not change any released version's
outcome. A behaviour change ships as a new version whose content switches the new behaviour on.
Older versions don't carry the switch, and a missing switch means the old behaviour. The
rules-version check (section 10) enforces this on recorded logs, and the production audit
(section 9) is the backstop.

**Versions only go forward.** Along one farm's log, versions never decrease. The commit refuses a
row whose version is lower than the farm's latest row, and the audit flags one. An instance whose
code doesn't know a farm's version answers 503 and writes nothing. This covers the overlap at a
deploy, when an old instance can meet a farm a new one has already moved on. **A released version
is never withdrawn:** a rollback ships the old content again as a new version, so it is a fix
forward.

**Rejected:**

- **Keeping old sim builds side by side**, each pinned to its version. Any change would be
  possible, but client and server would carry several copies of the sim to maintain.
- **Letting code changes alter old versions' outcomes.** Every farm would need an eager rewrite
  under the old code before such a change shipped: the deploy job section 3 rejects.
- **A database row naming the live version, which instances must match before serving.** It stops
  overlap writes too, but it adds a deploy step and still needs fix-forward for a rollback.
- **Rolling back code with every build carrying the whole registry.** Possible, but it ties every
  rollback to a registry that never shrinks, and the commit check already makes the overlap safe.

## 9. Audits (Q8)

`stateAt(t)` (ADR-0001, MUST-16.2) replays the rows with `at ≤ t` as section 5 does, then advances
to `t` under the version of the next row after `t`, or under the current version if there is none.
That is what `load` gives the player, so an audit sees what the player got. For a farm with no
base snapshot yet, the answer for a `t` in its release gap follows the current version, and can
shift if another release lands before the farm acts again (Consequences).

**Log against snapshots** (MUST-16.3) replays from the first action (`newFarm` under the first
row's version), upgrading wherever the rows step up a version. It compares each snapshot under the
version it was written with, at its seq (a base snapshot after the upgrade), and **each row's
stored answer hash** after that row. A farm where any of them differ, or whose versions decrease,
is flagged. Comparing the answer hashes covers the tail after the newest snapshot and farms under
100 actions, so editing a row or its version tag is flagged too (MUST-16.4, T10).

**Rejected:** advancing a gap under the old version until a base exists. History would be stable
until the farm acts, but the audit would disagree with what `load` produces for the same farm.

## 10. The rules-version check (Q9)

The check that proves this decision, for a build issue to carry, is the **rules-version check**: a
Vitest suite in `packages/sim`, next to the registry, run by `ci / test` (no new job). For every
released version it asserts:

1. **Frozen content:** `stateHash(content)` equals the hash recorded when the version was released.
2. **Old logs replay:** every recorded log of that version replays on today's code to its recorded
   hashes: each row's answer hash and the final farm's (MUST-13.6, section 8).
3. **Upgrades are total and keep the farm:** a property over generated farms of that version
   (fast-check, fixed seed, as ADR-0003 section 9): upgrading to the next version and on to the
   current one never throws, the result satisfies MUST-14's invariants and the JSON round trip,
   and it keeps the facts both versions share unless that version's `upgrade` declares otherwise.
4. **Across the boundary:** each recorded log, upgraded and continued with generated actions under
   the current version, gives the same hash whether replayed from its first action or from a base
   snapshot written at the boundary (MUST-16.3 across a release).

**Recorded logs:** at each release, the property harness's generator (fixed seed) records a set of
logs with their hashes. After playtest 1, a sample of real logs is added. Their farm ids are
pseudonymised first; the farm id seeds the PRNG streams (ADR-0003, section 7), so the hashes are
recorded by replaying the pseudonymised log under its own version.

**Rejected:**

- **Generated logs only.** No personal data, but they only cover the paths the generator reaches.
- **Real logs only.** Representative, but none exist before playtest 1, and they need
  pseudonymising.

## The client

The registry is server-only. The client imports only the current version's content, so the bundle
doesn't grow with each tuning. Every game API answer carries the rules version, and a client
running a different version reloads instead of predicting under the wrong rules (MUST-12). The
upgrade runs only on the server: the client receives farms already upgraded.

## Patterns

| Pattern | Where | Why |
| --- | --- | --- |
| Event Sourcing with versioned events and snapshots | log rows and snapshots carry a rules version | The log stays the source of truth across rules changes, and replay knows which rules each row was accepted under. |
| Registry | version → content and `upgrade` | Old rules are kept as data (ADR-0003's `createSim(content)`), not as old code. |
| Upcaster, chained | `upgrade` per version | One place changes a farm's shape between versions; the rules only see their own shape. |
| Lazy migration on the next write | base snapshot in the first commit | No deploy job, reads never write, inactive farms cost nothing. |
| Feature switch in content | behaviour changes in the rules code | One sim reproduces every version; the switch is part of frozen content. |
| Monotonic version with fix-forward | commit check, 503 on unknown versions | Overlapping deploys and rollbacks can't write a farm backwards. |
| Golden-file (recorded log) tests plus property-based tests | the rules-version check | Recorded logs pin old outcomes; generated farms reach the upgrade cases recordings miss. |

## Consequences

- **M3's schema (#74) carries the version.** `actions` gains a `rules_version` column, and
  `snapshots` too, keyed by (farm, seq, rules version), which amends ADR-0001's (farm, seq). The
  commit writes the base snapshot in the action's transaction and refuses a version lower than the
  farm's latest. `replay`, `load` and `stateAt` take versions as section 5 describes. The answer
  carries the rules version.
- **The determinism gate (#48)** runs per released version: a script's expected hash changes only
  when a new version is added, never for a released one.
- **The sim tickets store end times for running timers** (#82, #84, #86, #87, #88), and #82's
  `createSim(content)` is what the registry calls per version. The registry, `upgrade` and the
  rules-version check are built before the first release (M3); a build issue carries them.
- **#89's content check runs on every version in the registry**, not only the current one.
- **Content changes after the first release are new versions.** `CONSTRAINTS.md`'s "Content
  change" row waited on this decision; whether it changes is the admin's call, outside #31.
- **Accepted trade-off: rules code is frozen only by sampled logs.** A refactor can change an edge
  case no recorded log reaches. The rules-version check narrows that, and the production audit
  (MUST-16.3) flags a farm it hits. Fixing an exploit retroactively is not possible without
  breaking the logs that used it: such a fix ships as a new version, and the farms it touched are
  for the admin to judge.
- **Accepted trade-off: versions and content switches accumulate.** Every released version's
  content and `upgrade` stay in the server's registry for as long as any log uses them, which for
  audits is for good. Behaviour can be switched off for new versions, never removed for old ones.
- **Accepted trade-off: offline time across a release follows the new rules** (section 4).
  Automated steps that start in the gap, such as a Loop restarting or an order slot refilling, use
  the new version's durations, yields and tables, even where the client showed the old ones.
- **Accepted trade-off: `stateAt` for a farm without a base snapshot follows the current version
  in its release gap** (section 9), so it can change with the next release until that farm acts.
- **A rollback is a new version.** Withdrawing a released version would strand every farm that has
  acted under it.
