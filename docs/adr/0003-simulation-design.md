---
status: accepted
---

# Simulation design: rules as a function of content, next-event advance, hash and randomness inside

`packages/sim` is the one simulation that client and server both run (MUST-10). Its state and
action types are what the action log and the snapshots store (ADR-0001), so their shape is costly
to change once M3 builds the schema. This ADR records how the sim is built before its first line
of code: how content reaches the rules, how `advance` moves a farm through time, what time and the
state look like, how a refusal is returned, where the state hash lives (MUST-10.5) and where
randomness comes from. The tickets under #72 build on it.

## How this was decided

The kickoff grill on #72 with the admin, 8 Nov 2026, settled decisions D1–D14; this ADR records
D5–D13. D1–D4 (the slice content) and D14 (the records) are scope, not design, and stay on #72.
Writing it down exposed four gaps, which the admin answered on 8 Nov: how `apply` returns a
refusal (now D15), and the rejected alternatives for time (D7), the generator (D9) and the state
shape (D12). The review of this ADR added D16 (integer-only numbers and maths), the pattern for
the property tests (D10), and how the stream seed is read from the hash (D9). All of these are on
#72's Decisions as well. Each section names its D-number.

The spike's sim (`prototypes/persistence/src/sim.ts` on the unmerged branch
`prototype/persistence`) is the reference, not a port: it imports `node:crypto`, which the real
sim can't.

## The interface

```ts
type ApplyResult = { ok: true; state: FarmState } | { ok: false; reason: string };

function createSim(content: Content): {
  newFarm(farmId: string): FarmState;
  apply(state: FarmState, action: Action, at: number): ApplyResult;
  advance(state: FarmState, to: number): FarmState;
};

function stateHash(value: unknown): string; // 64 lowercase hex digits; the same for every content
```

`at` and `to` are integer ms of server time. `apply(state, action, at)` and `advance(state, to)`
keep the signatures in `AGENTS.md`; `createSim` adds the content around them. A player has one
farm (spec, Actors), and a farm's id is its player's id, so `newFarm(farmId)` here is ADR-0001's
`newFarm(playerId)`.

## 1. Rules as a function of content (D5)

The rules are a function of content: `createSim(content)` returns `{ apply, advance, newFarm }`.
Content is a value handed in, never imported as constants inside the rules. The state carries no
version field.

This keeps every option of #31 (replaying old logs after a rules change) open. Keeping an old
rule version means keeping an old content object and calling `createSim` with it; nothing in the
rules or the state has to change for that. So #31 doesn't block M2. It is due before M3's schema.

**Patterns:** dependency injection of content through a factory function (`createSim` closes over
it); content as data (MUST-10.4).

**Rejected:**

- **Content imported as module constants**, as in the spike (`GROW_MS`, `BAKE_MS`). It binds the
  rules to one version of the content, so replaying a log under older content would need a second
  copy of the rules.
- **A version field in the state.** It would choose one of #31's options before #31 decides.

## 2. `advance` is a next-event loop (D6)

`advance(state, to)` repeatedly takes the earliest automated step at or before `to` and processes
it, until none is left. Steps at exactly `to` are processed. When several steps fall at the same
time, MUST-10.6's key breaks the tie: time, then kind of automated step, then facility, pen, plot
or order slot index, then queue slot. The key is defined once in the sim. `apply` advances to `at` first, then
applies the action, then advances to `at` once more, so the steps the action made due at `at` run
before the farm is returned (the order slots a crossed Level adds, section 15; the Loop's
restarts, section 16).

Because steps at exactly `to` are processed, `advance(advance(s, t1), t2)` and `advance(s, t2)`
process the same steps in the same order, so time-splitting (MUST-14.1) holds by construction.

**Pattern:** discrete-event simulation, with next-event time advance. That is only the pattern's
name: the code and tickets call each step an *automated step* (D11, below).

**Rejected:**

- **Fixed ticks.** At one tick per second that is 604,800 steps per entity per week, and the tick
  length is arbitrary.
- **A closed form per entity** (computing each plot's or facility's output from elapsed time
  alone). It breaks once automated steps share storage: a Collector filling the barn changes what
  a Loop can start, so one entity's output depends on the others' order.

## 3. Time (D7)

The state has `time`: the server time it has been advanced to. `time`, `at` and `to` are integer
milliseconds. Content timers are whole seconds (MUST-10.4) and are converted to ms once, in
`createSim`.

- A `time`, `at` or `to` that isn't a safe integer (`Number.isSafeInteger`) throws: it is a
  programmer error, not a rule.
- `advance(s, to)` with `to < s.time` returns the farm unchanged. `advance` is total and
  idempotent.
- `apply(s, action, at)` with `at < s.time` is refused (section 4). MUST-14.7 (time never runs
  backwards) then holds in the sim itself, not only through the handler's clamp
  `at = max(serverNow, lastAt)` (ADR-0001).

**Pattern:** none (a representation choice).

**Rejected:**

- **Seconds as sim time.** Server time and the log's `at` are already integer ms (ADR-0001), and a
  second conversion at the boundary invites off-by-one rounding.
- **Fractional numbers or `Date` objects.** Float arithmetic would put rounding into the state
  hash, and a `Date` isn't plain JSON (section 5).

Content stays in seconds because MUST-10.4 states its timers that way.

## 4. Refusals are returned, not thrown (D15)

`apply` returns `{ ok: true, state }` or `{ ok: false, reason }`, with `reason` a string, as the
spike did. It never throws on a refusal. A refusal carries no state, so the caller keeps the farm
it had: the advance to `at` that ran before the check isn't kept (MUST-14.6). Throwing is kept for
programmer errors, such as a time that isn't a safe integer (section 3).

ADR-0001's `replay` is unchanged: if the rules refuse a logged action, `replay` throws, because a
logged action was accepted once and a refusal there is a bug or a rules change (#31).

**Pattern:** Result-typed refusals (a discriminated union return).

**Rejected:** throwing on a refusal. A refusal is an expected outcome that the handler maps to a
422, not an exceptional one.

## 5. The state is plain JSON data (D12)

The state holds only plain JSON data: no `Map`, `Set`, `Date`, `bigint`, `undefined` or class
instances. Its types are `readonly`.

- **Facts are stored:** `time`, coins, XP, goods per store, plots, owned facilities with their
  tier, add-ons and queue, pens and troughs, order slots, and the PRNG streams (section 7).
- **Derived values are computed from content:** Level, what is unlocked, what is producible.
- Plots, facilities, pens and queue slots are indexed arrays in content order.
- Goods are records keyed by good id.
- Statuses are discriminated unions.

**Patterns:** plain immutable data (the functional core of ADR-0001's "functional core,
imperative shell"); single source of truth for derived values; discriminated unions for statuses.

**Rejected:**

- **`Map`, `Set` or class instances.** They don't survive JSON, which the snapshots and the JSON
  round-trip property (section 9) need. A `Map` also iterates in insertion order, and MUST-10.6
  forbids deciding an order that way.
- **Storing derived values such as Level or unlocks.** Two copies can disagree, and a content
  change would leave stale stored values.
- **Goods as arrays.** Adding a good would shift the indexes in old snapshots.

Never decide an order by iterating object keys (MUST-10.6): the goods records are keyed, not
ordered.

## 6. The state hash is in the sim (D8, settles MUST-10.5)

`stateHash(value)` is canonical JSON (object keys sorted at every level) hashed with SHA-256
written in pure TypeScript, returned as 64 lowercase hex digits, and `packages/sim` exports it.
How the canonical JSON orders keys and treats non-finite numbers is in section 10. It is tested
against the NIST vectors and against vectors for inputs of 55, 56, 63, 64 and 65 bytes, around
SHA-256's 64-byte block and padding boundary. Those vectors are recorded once from `node:crypto`
and committed as literals, so the tests keep the purity boundary too.

This settles ADR-0001's open bullet on where the state hash lives and spec MUST-10.5.

**Patterns:** canonical serialization, then a cryptographic hash.

**Rejected:**

- **A non-cryptographic 53–64-bit hash:** collisions across many farms and snapshots.
- **Hashing outside the sim**, in server and client code. That is two implementations that can
  drift, and the browser's `crypto.subtle` is async.

## 7. Randomness: one mulberry32 stream per purpose (D9)

Each purpose has its own stream: **yields** and **orders**. A stream's seed is the first 32 bits of
`stateHash(farmId + ":" + purpose)`, so a new farm is the same on every server (MUST-10.3,
ADR-0001). Exactly: `stateHash` of a string hashes the UTF-8 bytes of its canonical JSON, which is
the JSON-encoded string with its quotes (for farm `farm-1`, the 15 bytes `"farm-1:yields"`). The
seed is the first 8 hex digits of the result, read as a big-endian unsigned 32-bit integer. The
generator is mulberry32, as in the spike, and the streams' states live in the farm state
(section 5).

**Patterns:** seeded PRNG; independent streams per purpose.

**Rejected:**

- **One shared stream.** A new draw in one rule would shift every later draw in the others.
- **sfc32 or xoshiro128\*\*.** A 128-bit state is four numbers per stream, for better statistics
  the game doesn't need. mulberry32's 32-bit state is one safe integer in plain JSON, it is about
  ten lines of pure TypeScript, and the spike's gate already showed it deterministic.
- **A hash per draw** (SHA-256 of seed and counter). Too slow for `advance`'s budget (section 8).

## 8. Speed budget (D13)

The sim is designed for `CONSTRAINTS.md`'s sim speed row: `advance()` across 30 days on the
largest content farm in ≤ 50 ms, and `apply()` ≤ 1 ms per call. `spec.md` MUST-07.4 said 7 days
and is corrected to 30 to match. The `advance` ticket reports a `vitest bench` at 30 days in its
PR. That isn't gating yet: the bench check is #41 (M3).

**Pattern:** none (a budget).

**Rejected:** designing for 7 days (MUST-07.4's old figure). `CONSTRAINTS.md` is canonical, and
offline catch-up runs inside a request with a 300 ms p95 budget (BASE-04).

## 9. How it is verified (D10)

All of MUST-14.1–14.8 are property tests in M2, over the real slice content, with fast-check and a
fixed seed:

- **14.2** is restated for a sim without a server: replaying the accepted actions from a
  serialized snapshot taken mid-run gives the same hash as the uninterrupted run.
- **14.3** compares two fresh `createSim` instances. The two-process gate is #48 (M3).
- **14.5** has no gift exceptions yet (gifting is M6).
- **Added:** idempotent `advance`, and a JSON round trip (`JSON.parse(JSON.stringify(s))`
  deep-equals `s`).

Each property runs 100 times at task end and 1,000 times in CI. The root Vitest config reads the
count from `SIM_PROPERTY_RUNS`, which `ci / test` sets (#40), and hands it to the tests with the
fixed seed (`fc.assert(property, inject('fastCheck'))`), so no sim test reads the environment.

A property's time grows with its run count, so its timeout does too (#200): the config also
provides `propertyTimeout`, 15 ms per run and never below Vitest's 5 s default, and each property
test file applies it with `vi.setConfig({ testTimeout: inject('propertyTimeout') })`, which Vitest
resets after the file. At 1,000 runs that is 15 s: 4× the slowest property measured in CI on
main (3.7 s) and 2.6× the slowest on #88's stack (5.7 s), enough for a slow runner and tight
enough that a property several times slower still fails.

**Pattern:** property-based testing (fast-check, fixed seed), with a timeout scaled by the run
count.

**Rejected:**

- **Example-based tests only.** They can't reach the generated tie and storage cases that
  MUST-14.8 needs.
- **A fresh random seed per run.** A failure couldn't be reproduced, and CI would flake.
- **A global `testTimeout`.** It would loosen every unit test, not only the properties (#200).
- **50 ms per run.** 50 s at 1,000 runs would hide a property getting ten times slower (#200).
- **Fewer runs.** A lowered run count is a weakened bar (`CONSTRAINTS.md`, Floor).

## 10. Numbers are safe integers, and the maths is integer-only (D16)

Approved by the admin on 8 Nov, in the review of this ADR (PR #100).

- **Every number in the state is a safe integer** (`Number.isSafeInteger`).
- **No transcendental or engine-dependent maths in the rules:** no `Math.pow` with a non-integer
  result, no `Math.exp`, `Math.log`, `Math.sin` and so on. Their results can differ between V8
  and JavaScriptCore, which would split client and server hashes. Multipliers and growing costs
  (#83, #85) stay in integers, for example per-mille with floor division, as defined in content.
- **No 32-bit operators on times** (`|0`, `>>>0`, `<<`): they truncate above 2^31 ms (about 24.9
  days), inside the 30-day window (section 8). The rule is about times: mulberry32's stream state
  is a 32-bit value by design (section 7).
- **`stateHash`'s canonical JSON sorts object keys by UTF-16 code unit** (the default
  `Array.prototype.sort` order, never `localeCompare`), and **throws on a non-finite number**:
  `JSON.stringify` would silently turn `NaN` and `Infinity` into `null`.

**Pattern:** integer fixed-point arithmetic (per-mille, floor division), defined in content.

**Rejected:**

- **Floats rounded at the end.** `Math.pow`, `exp` and `log` can still differ between V8 and
  JavaScriptCore before the rounding.
- **`bigint`.** It isn't plain JSON (section 5).
- **A pure-TypeScript deterministic maths library.** More code to verify, for curves that integers
  already express.

## 11. Progress: a derived Level and one purchase rule (#83)

Approved by the admin on 11 Nov, in #83's interface review.

`progress/` owns the Level, unlocks and buying (ADR-0005, section 3). Its interface:

- `levelOf(xp)`: the Level is the number of Level-table rows whose XP the farm has reached
  (MUST-05.3). It is derived on every call and never stored (section 5).
- `gainXp(farm, xp)`: every rule that earns XP calls it. It pays the level-up coins of each Level
  whose XP lies above the farm's old XP and at or below its new XP (MUST-05.4). XP never goes
  down, so each Level is crossed, and paid, once in a farm's life, however many Levels one gain
  crosses. The state needs no "paid" flag. That holds within one rules version. A version that
  moves a Level's XP across farms that already passed it would pay that Level twice, or never, so
  its `upgrade` handles those farms (ADR-0006, section 6).
- `purchase(farm, offer)`: the one purchase rule (spec decision 1, MUST-05.6, D3). An offer names
  what is bought, the Level that unlocks it and its price. A purchase is refused while the farm is
  below that Level or has too few coins (MUST-05.1). Otherwise the farm pays the price, and the
  caller adds what was bought. Plots are its first use. Facilities and pens (#84, #86) build on
  it.
- `cropLocked(cropId, xp)`: why a crop can't be planted yet, or null once its Level is reached
  (MUST-01.1). A crop that no Level lists is never unlocked. #89's content check keeps every crop
  reachable (MUST-05.5).

The Level table lives in content, as one row per Level, Level 1 first. Each row gives the XP that
reaches the Level, its level-up coins and what it adds: crops, and the extra plots the farm may
buy. #84–#88 add their own fields. A growing price, such as a plot's, is computed by repeated
integer steps in content's per-mille (section 10), once in `createSim`.

`buyPlot` names the plot it buys, which must be the farm's next one. An action sent twice
therefore buys one plot, and the sim refuses the second, on top of ADR-0001's idempotency keys.

**Patterns:** single source of truth for derived values (the Level); policy function (one purchase
rule shared by every upgrade); integer fixed-point arithmetic (the price curve).

**Rejected:**

- **Storing the Level or the Levels already paid.** Two copies can disagree, and a content change
  would leave stale values (section 5). Crossing thresholds already pays each Level once.
- **A purchase rule per feature.** The Level and coin refusals would be written several times and
  could drift. ADR-0005 puts the shared rule in `progress/`'s interface.
- **A price list per plot in content.** Simpler to read, but #85's growing costs would need a
  second list per facility. A first price and a per-mille growth state the curve once.
- **`Math.pow(growth, n)` for the curve.** Its float result can differ between engines (section 10).
- **`buyPlot` with no plot.** A resent action would buy a second plot.

## 12. Facilities, jobs and storage (#84)

Decided by #84's lane on 11 Nov, under the admin's brief (content values and these shapes are the
lane's call, reviewed in its PRs' "Decided by the lane").

`facilities/` owns buying facilities and running jobs; `storage/` owns the silo and the barn
(ADR-0005, section 3).

- **Storage.** A crop goes to the silo, every other good to the barn (MUST-06.4); each has a
  capacity from content. `put(goods)` is refused if the good's store can't hold it all, and
  `take(inputs)` takes every input in list order, or is refused naming the first that is short.
  Harvesting, starting a job and collecting one all go through it: the silo's room check left
  `plots/` at this second occurrence (ADR-0005, "Shared logic").
- **Buying.** `state.facilities` has one entry per content facility, in content order: `null`
  until bought, then `{ tier, jobs }`. A facility is unlocked by the first Level-table row that
  lists it and bought through `purchase` (section 11). Owned facilities store `tier: 1` from the
  start (the admin's decision, 11 Nov), so #85 adds tiers without changing the persisted shape. `buyFacility` is refused for a
  facility the farm has, so an action sent twice buys it once.
- **Jobs.** A facility's `jobs` is its queue, in the order the jobs started; a job's queue slot is
  its position (MUST-03.5). Starting a job needs the recipe at the facility's tier, a free slot
  and every input in storage; the inputs leave storage at the start (MUST-03.2). The job stores
  `readyAt`, the later of its start and the previous job's `readyAt`, plus the recipe's duration,
  read from content once (MUST-03.3; ADR-0006, section 7). A running job becomes done as an
  automated step at `readyAt`, of kind `finishJob`, keyed by the facility's index and the job's
  slot (section 2). Collecting takes the job in slot 0 once it is done: its goods go to the barn
  and its XP through `gainXp` (MUST-03.4, 05.2), and the jobs behind it move up a slot.
- **Step kinds.** `finishJob` ranks after `ripen`. Neither touches storage, so today the rank
  changes no outcome; producing kinds rank before the kinds that will move or use goods (the
  Collector and the Loop, #88), so a step at the same time sees what was produced at it.

**Patterns:** queue (FIFO) with stored end times; the strategy behind `StepSource` (a feature
adds its automated steps without changing `advance`); a shared module for a repeated rule
(`storage/`); the policy function of section 11 for buying.

**Rejected:**

- **A fixed array of slots with holes for collected jobs.** "The previous job" would then need a
  start order stored beside the slots; the queue's order already is it.
- **Deriving "done" from `readyAt` and the farm's time, with no step.** A finished job is an
  automated step (`GLOSSARY.md`), and the Collector (#88) needs it as one to move goods at the
  right moment in MUST-10.6's order.
- **Storing a job's start time and deriving its end.** A tuning would move work in flight
  (ADR-0006, section 7).
- **Collecting every done job at once.** One job a call lets a player collect what fits when the
  barn can't hold them all.
- **One goods store.** The spec gives the silo and the barn separate capacities (MUST-06.4).
- **A room check in each feature.** It would be written three times, and `fallow dupes` fails on
  the copies.

## 13. Pens and troughs (#86)

Chosen by #86's lane on 11 Nov, unattended; the admin reviews it in #86's PRs ("Decided by the
lane").

`pens/` owns the animal pens (ADR-0005, section 3). Content lists pens in an array; the state has
one entry per content pen, `null` until bought (MUST-05.6). A bought pen stores its trough's
portions, one status per animal in slot order (`idle`, or `producing` with the `readyAt` it
produces at) and the products waiting. A pen is unlocked by the first Level-table row that lists
it and bought through `purchase` (section 11). Its actions name the pen, so `buyPen` sent twice
buys one.

- **Feeding** takes as much feed from the barn as fits in the trough and the barn holds, through
  `storage/` (section 12). Idle animals then eat from the trough at once, in slot order, so no
  animal is idle while the trough holds feed.
- **Producing** is an automated step of kind `produce`, keyed by the pen's index and the animal's
  slot (section 2). The animal adds one product to the pen, then eats the next portion at the
  time it produced, if the trough holds one (MUST-02.3). When animals produce at the same time
  and one portion is left, the lowest slot eats it (MUST-10.6).
- **Collecting** puts every waiting product in the barn through `put`, and gives the pen's XP per
  product through `gainXp` (MUST-02.4, 05.2).
- **Each `readyAt` is stored when the animal eats**, read from content once, so a later rules
  version doesn't move it (ADR-0006, section 7). The next portion's time is read from the rules
  running when the animal produces. Across a release, a gap is advanced under the new version
  (ADR-0006, section 4), so a portion eaten in that gap uses the new duration. A portion eaten
  before the release keeps its stored time.
- **Step kinds.** `produce` ranks after `finishJob`, for section 12's reason: it touches neither
  storage nor coins and changes only its own pen, so today its rank changes no outcome, and it
  produces goods, so it ranks before the kinds that will move them (the Collector and Farmhands,
  #88).

**Patterns:** a discriminated union per animal with a stored end time (section 5); the
`StepSource` strategy of section 12, here closed over the pen rules because an animal's next
portion reads its duration; the shared `storage/` module (section 12).

**Rejected:**

- **One status per pen** (the pen is producing until a time). Animals in one pen eat at different
  times, and MUST-02.3 is per animal.
- **A count of producing animals with one shared end time.** It can't hold animals that ate at
  different times, and it would lose the stored end time ADR-0006 section 7 asks for.
- **Eating at the next step instead of at once.** An animal would wait idle beside a full
  trough, and when it eats would depend on unrelated steps.
- **Products straight to the barn as they are produced.** MUST-02.4 keeps products in the pen
  until collected, and a full barn would then need a rule for where a product goes.

## 14. Facility tiers (#85)

Chosen by #85's lane on 11 Nov, unattended; the admin reviews it in #85's PRs ("Decided by the
lane").

- **Content.** A facility keeps its tier-1 `slots` and lists the tiers it can be upgraded to,
  tier 2 first, as rows of price, slots and `timePerMille`. The highest tier is the last row, so
  the slice stops at 3 (MUST-06.2) and SHOULD-08 adds rows. The Level table lists each tier it
  unlocks as `{ facility, tier }` (MUST-05.5), read by `progress/`'s `findTierLevel`.
- **Buying.** `buyTier` names the facility and the tier, which must be the facility's next, so an
  action sent twice buys one tier. It goes through `purchase` (section 11) and only raises the
  stored `tier` (section 12): no new field in the state.
- **Job times.** A tier's time is the recipe's `seconds` times its per mille, rounded down to whole
  seconds, then in ms, worked out for every tier once in `createSim` (sections 3, 10). Whole
  seconds let #89's content check hold every tier's time to MUST-10.4's 10 s–24 h, which it has
  to check per tier: a recipe's tier-1 `seconds` alone doesn't bound it.
- **Reads.** `startJob` reads the slots and the time of the facility's tier when it runs, and the
  job stores its `readyAt` (section 12), so a tier bought later never moves a job already queued or
  running (MUST-03.3, 06.7; ADR-0006, section 7). The Loop (#88) restarts through `startJob` and
  reads them the same way.

**Patterns:** the policy function of section 11 for buying; a table of tier rows looked up by
index (table-driven rules); integer fixed-point arithmetic (section 10) for job times.

**Rejected:**

- **Slots as a formula in the rules** (one more every 2nd tier, up to a maximum). MUST-06.2's
  shape would be fixed in code, while the spec puts numbers in content; a row per tier states it
  and #89's content check holds it to MUST-06.2.
- **A seconds list per recipe and tier.** More numbers to tune for one rule; a per mille per tier
  shortens every recipe alike.
- **A growing price curve per facility,** as plots have (section 11). Each tier already has a row
  for its slots and time, so its price sits there.
- **The unlock Level in the tier row.** MUST-05.5 puts every unlock in the Level table.
- **`buyTier` with no tier.** A resent action would buy two tiers.

## 15. The order board (#87)

Chosen by #87's lane on 11 Nov, unattended; the admin reviews it in #87's PRs ("Decided by the
lane").

`orders/` owns the order board (ADR-0005, section 3). The state's `board` has one entry per slot
the farm's Level gives (MUST-04.1): `open` with its order, or `empty` with the `refillAt` it
refills at. An order stores its goods (1–3 different goods, in the order drawn), its coins and its
XP, all fixed when it is drawn. Content gives each Level-table row the order slots it adds, the
goods it unlocks for orders and the two refill delays at that Level; `content.orderGoods` gives
each good's fewest and most per order and its coins and XP per good, in content order.

- **Drawing.** An order is drawn from the **orders** stream (section 7), from the goods unlocked
  for orders at the farm's Level, in content order: one draw for how many kinds (1 to 3, at most
  the goods there are), then for each kind one draw for which of the goods left and one for its
  amount. Each draw is a uint32 modulo a count (section 10). Coins and XP are the amounts times
  each good's coins and XP.
- **Producible** (`GLOSSARY.md`) is derived, never stored: a crop the Level unlocks, a recipe's
  output once its facility is bought at the recipe's tier, a pen's product once the pen is bought.
  It never goes back within a rules version. While another open order asks for a good the farm
  can't produce, a draw picks only from producible goods, so at most one open order does
  (MUST-04.3). Level 1 must unlock a crop for orders, so that list is never empty; `createSim`
  throws a RangeError otherwise.
- **Delivering** takes every good through `storage/`'s `take`, whole or not at all (spec
  decision 2, MUST-04.4), adds the coins, and gives the XP through `gainXp` (section 11). **Discarding**
  only empties the slot. Both store `refillAt`: the farm's time plus the delivered or discarded delay
  of its Level, read from content once (MUST-04.5; ADR-0006, section 7). The delivered delay is the
  one of the Level the delivery's XP reaches.
- **Refilling** is an automated step of kind `refillSlot`, keyed by the slot's index (section 2):
  an empty slot draws a new order at its `refillAt` (MUST-04.6). A slot that a new Level adds is
  drawn at once, as a `refillSlot` step at the farm's time with the next index, one slot at a time.
  `apply` advances to `at` again after the action (section 2), so a Level an action crosses opens
  its slots before the farm is returned. A new farm draws its Level 1 slots in `newFarm`.
- **Step kinds.** `refillSlot` ranks after every kind on main (`ripen`, `finishJob`, `produce`).
  It reads the Level and what is producible, which a step at the same time can change (#88's
  Collector gains XP), and a slot that a Level adds is due at the time the Level is crossed, which
  ranks after the step that crossed it only if refills rank after every kind that gains XP;
  otherwise `advanceFarm` would throw. A refill changes only its slot and the orders stream, which
  no other kind reads, so it never makes an earlier-ranked step due at its own time. **The admin's
  decision (b), 11 Nov:** #88's `moveGoods` (the Collector, which gains XP) ranks before
  `refillSlot`, and its `restartRecipe` (the Loop, which gains none) ranks last, after it. #88
  isn't merged yet: whichever of #87 and #88 merges second sets that final order,
  `["ripen", "finishJob", "produce", "moveGoods", "refillSlot", "restartRecipe"]`, with one
  kind-order test covering all six.

**Patterns:** a discriminated union per slot with a stored end time (section 5, as for animals in
section 13); a seeded draw from a pool filtered before the draw (section 7); a derived predicate
for producibility (section 5's single source of truth); the `StepSource` strategy of section 12;
the shared `storage/` module and `progress/`'s `gainXp` (sections 11, 12).

**Rejected:**

- **Rejection sampling** (draw, and draw again while MUST-04.3 fails). The number of draws per
  order would be unbounded, and each would shift the orders stream; filtering the pool first takes
  a fixed number of draws.
- **A stored flag on each order for "asks for a good the farm can't produce".** It is derived
  from the farm and content, and two copies can disagree (section 5).
- **Drawing the next order when the slot empties**, kept hidden until `refillAt`. MUST-04.3 and
  the unlocked goods are about the moment the order is drawn, and a Level reached during the wait
  would be ignored.
- **Growing the board inside `gainXp`.** `progress/` would depend on `orders/`, and a Level crossed
  by a step (#88's Collector) would still need a step.
- **A slot count with a list of open orders.** It can't hold an empty slot's stored refill time.
- **One refill delay for the whole board, or delays per good.** MUST-04.5 gives one pair per Level.

## 16. The Loop and the Collector (#88)

Decided by #88's lane on 11 Nov, under the admin's brief (content values and these shapes are the
lane's call, reviewed in its PRs' "Decided by the lane"); the Loop's limit is the admin's decision
in the stack's review, 11 Nov.

The add-ons live in `facilities/` (ADR-0005, section 1): nothing else uses them yet, since the pen
Collector is SHOULD-08.

- **State.** An owned facility stores `addOns: { loop, collector }`, both `false` when bought (an
  add-on exists only once bought, MUST-05.6), and `lastRecipe`: the recipe of the job started
  last, by hand or by the Loop, `null` until one starts. The queue forgets a recipe once its job
  is collected, so the Loop's "last recipe" (MUST-06.5) is a stored fact (section 5).
- **Buying.** `buyAddOn(facility, addOn)` goes through `purchase` (section 11): each add-on is
  unlocked for every facility by the first Level-table row that lists it in `addOns`, and costs
  content's `addOns[addOn].price`. It is refused for a facility the farm hasn't bought, an add-on
  not in content, or one the facility has, so an action sent twice buys it once.
- **The Collector** is one `moveGoods` step per facility and time, keyed by the facility and slot
  0. It falls when one of the facility's jobs finishes, in place of `finishJob`, and a ms after the
  farm's time whenever the facility's oldest job is done and its goods fit. It finishes the jobs
  due, then moves the done jobs into the barn through `storage/`'s `put`, oldest first, while they
  fit, each with its XP through `gainXp`, as collecting by hand does (the two share one rule).
  Goods that don't fit wait in their slot (MUST-06.6) and move a ms after the barn has room; goods
  already waiting when the Collector is bought move a ms after it, if they fit. Room that a step or
  an action frees at a time is so used at the next, never behind a step already run at it
  (MUST-10.6).
- **The Loop** restarts whenever its facility has a free slot and the inputs are in storage: a
  `restartRecipe` step at the farm's time, keyed by the slot it fills, that starts the last recipe
  through `startJob`, so the job stores its finish, at the facility's tier, when it starts
  (ADR-0006, section 7; section 14).
- **The Loop's limit is the queue** (MUST-06.5, 07.2; the admin, 11 Nov). A done job keeps its slot
  until its goods are collected: by hand, or by the Collector once bought. When every slot is
  taken, running or done, the facility stops producing, whether or not the barn has room, and it
  resumes as soon as a slot frees: after a collect, a Collector's move, or a tier that adds a slot
  (section 14). Without a Collector, a Looping facility fills its queue and waits for the player;
  with one, it stops when the barn is full (the waiting goods keep the slots) and resumes once the
  barn has room. It also stops when the inputs run out. There is no time cap.
- **`apply` advances once more after the action**, to `at`, so an automated step the action made
  due at its own time runs in the same call: a Loop restarting into a slot a collect freed, a Loop
  just bought, or a tier just bought. Every farm the rules return has then run its steps up to its
  time. This amends section 2, where `apply` only advanced before the action.
- **Step kinds.** `moveGoods` ranks after the producing kinds, so goods made at a time are moved at
  it; `restartRecipe` ranks last of all kinds (the admin, 11 Nov: after #87's order refills too),
  so a slot the Collector frees is refilled at the same time, and a slot its waiting goods hold is
  not. A restart only adds a running job that ends later; one that takes barn goods (cookies take
  eggs, #85, MUST-03.1) frees room, which the Collector uses a ms later, so no step falls due behind
  one already run at the same time (MUST-10.6).

**Patterns:** level-triggered automated steps (the Collector acts a ms after its oldest job's goods
fit, besides its step at a job's stored finish; the Loop whenever a slot and the inputs are there);
the strategy behind `StepSource` (section 12), chosen per facility by its stored add-ons; the
policy function of section 11 for buying; one rule reused by the player's action and the automated
step (`startJob` for the Loop, collecting for the Collector).

**Rejected:**

- **A Collector that acts only as a job finishes** (this stack's first version). Goods that
  waited for room would stay until collected by hand, so a Looping facility with a full queue of
  them would never resume on its own; the admin's queue rule needs them to move once there is room.
- **Moving waiting goods at the same ms the room appears** (this stack's second version). A Loop
  restart that takes barn goods (cookies take eggs) frees room at a time after the moves at that
  time have run, so a move would fall due behind a step already run, which `advance` throws on; a
  ms later is the earliest a move can follow it in MUST-10.6's order.
- **`finishJob` then a separate `moveGoods` of the done job.** A done job stores no time, so the
  move would need a status that lives only inside one millisecond, or a level-triggered step.
- **The Loop holding while the barn has no room for its goods** (a version from the review round,
  replaced the same day). The admin chose the queue as the limit: a job started in a free slot may
  take its inputs and wait for room, and the player sees a full queue, not a Loop that refuses to
  start beside an empty slot.
- **Starting the Loop inside `collect`, `buyAddOn` and `buyTier`, or moving waiting goods inside
  `buyAddOn` and `feed`.** Each action that frees a slot or room, or adds an add-on or a slot,
  would have to know about the add-ons, and a later action (harvesting the wheat a Loop waits for)
  would be one more place to forget; one advance after any action covers them all.
- **Leaving a step the action made due to the caller's next advance.** A farm `apply` returned
  would still have a step due at its own time: `advance(farm, farm.time)` would change it,
  breaking idempotent `advance` and MUST-14.2's replay from a snapshot.
- **One Loop step that fills every free slot.** One job a step, keyed by the slot it fills, keeps
  the keys unique, and each restart is its own entry in the away summary (MUST-07.3).
- **Add-ons as a list of ids.** A list has an order to keep canonical; a flag per add-on is one
  fact each.
- **A price per facility.** One price per add-on is enough for the slice; a field in `Facility`
  can add it later without changing the state.
- **A top-level `addOns/` module.** Nothing outside facilities has add-ons yet (ADR-0005,
  section 1).

## 17. The content check (#89)

Decided by #89's lane on 12 Nov, under the admin's brief; the admin reviews it in #89's PRs
("Decided by the lane").

MUST-10.4 asks for a content test. `content/`'s interface gains `checkContent(content)`: it
returns every rule the content breaks, each as `{ rule, path, message }` (for example `timer`,
`crops.wheat.growSeconds`, "crops.wheat.growSeconds is 0: a timer is …"), in a fixed order, and
an empty list for valid content. `content/tests/` runs it on `sliceContent` in `ci / test`, and
proves each rule with the smallest change to the slice that breaks it alone.

- **A function of a `Content` value**, like `createSim` (section 1). It never imports
  `sliceContent`, so #154's rules-version check runs it on each registry version's content
  (ADR-0006, "Consequences").
- **Not exported from the package.** The registry lives in `packages/sim` and imports
  `content/index.js`; `apps/web` only runs content the check has passed in CI.
- **`createSim` doesn't call it.** A frozen rules version must replay its logs for good (ADR-0006,
  section 2), so a rule added later can't be allowed to stop an old version's `createSim`; CI is
  where content changes. `prepareOrderRules` keeps its RangeError (section 15), the one rule
  without which the rules can't run at all.
- **The rule groups are private siblings** of `content/index.ts` (ADR-0005, section 1), each a
  function from content to failures. They read content the way the rules do: the first Level
  that lists an id unlocks it, a tier's job time and each plot price are worked out with the
  rules' integer steps (sections 10, 11, 14), and nothing is decided by object-key order
  (MUST-10.6).
- **A good's earliest Level** is a least fixed point: a crop at its unlock, a recipe's output at
  the latest of its facility's and tier's Levels and its inputs', a pen's product at the later of
  the pen's Level and its feed's. Values only fall, so it ends, and a cycle with no outside route
  never gets a Level. A recipe or pen whose input's Level is later than its own fails MUST-10.4's
  "produced by some unlocked route".
- **Readings of the spec it encodes.** MUST-06.2's "every 2nd tier adds a queue slot, up to a
  maximum": a tier never has fewer slots than the tier below, adds at most one, and two tiers in a
  row never both add one, so the admin's 2/3/3 (11 Nov, #85) passes and 2/3/4 doesn't; the maximum
  is content's. MUST-02.5's "at the start a trough holds one portion": `troughCapacity` is 1 until
  M6's trough upgrades (MUST-06.3). MUST-03.6's strawberry cake is M6's, so in the slice cookies
  stand in for it and need goods from crops and animals (#72 D4). MUST-05.5's storage capacity and
  trough upgrades are M6's too (#72 D3): the Level table has no lists for them yet, so the check
  can't reach them.

**Patterns:** Notification (failures collected and returned as data, not thrown); table-driven
validation (a list of rule functions, run in turn); a least fixed point for producibility.

**Rejected:**

- **Throwing on the first failure**, as `assertSafeIntegers` does. One failure per run hides the
  rest, and a test couldn't prove that a change breaks one rule and no other.
- **A schema library** (zod and the like). A runtime dependency in a package that has none
  (MUST-10.1), and the rules are mostly cross-references, which a schema states poorly.
- **Checking inside `createSim`.** See above; it would also turn every test content that bends a
  rule on purpose (the 4-good barn of `sim/tests/richContent.ts`) into an error.
- **Properties over generated content.** Slower (#200), and a shrunk random content names a rule
  less clearly than a one-value change to the slice.
- **Reusing the rules' own helpers** (`progress/`'s first-listing map and tier key, the plot and
  tier steps in `plots/` and `facilities/`). The check is an independent reading of what the rules
  assume: a bug in a shared helper would pass both, and `content/` would import the rules it feeds.
  The arithmetic is short and fixed by sections 10, 11 and 14.
- **A top-level `contentCheck/` module.** ADR-0005 (section 3) keeps content one module, and the
  check belongs with the types it reads.

## Vocabulary (D11)

**Automated step** (`GLOSSARY.md`): a change the farm makes by itself at a server time, with no
action behind it. Code and tickets say *automated step*, never "event", "tick" or "timer".
"Discrete-event simulation" appears only as the pattern's name (section 2).

## Patterns

| Pattern | Where | Why |
| --- | --- | --- |
| Dependency injection through a factory function | `createSim(content)` | Content is a value, so old content can be kept for replay without a second copy of the rules (#31). |
| Discrete-event simulation, next-event time advance | `advance` | Work scales with automated steps, not elapsed time, and time-splitting holds by construction. |
| Total ordering by a single tie key | MUST-10.6's key | Simultaneous automated steps run in one order on every machine. |
| Result-typed refusals | `apply` | A refusal is an expected outcome, returned as data; throws are for programmer errors. |
| Functional core, imperative shell | the sim and its callers | The sim is pure; the handler (ADR-0001) does I/O and supplies time. |
| Plain immutable data, discriminated unions | `FarmState` | It survives JSON for snapshots and hashing, and statuses can't be half-set. |
| Single source of truth for derived values | Level, unlocks, producibility | Computed from content, so they can't disagree with the stored facts. |
| Canonical serialization plus cryptographic hash | `stateHash` | One implementation, synchronous, with collisions that don't hide divergence. |
| Seeded PRNG, independent streams per purpose | yields, orders | Deterministic, and a draw in one rule doesn't shift another. |
| Property-based testing | MUST-14 | Generated farms reach the tie and storage cases; a fixed seed makes failures reproducible. |
| Integer fixed-point arithmetic | multipliers, growing costs | The same result in every JavaScript engine, so client and server hashes agree. |
| Policy function | `progress/`'s `purchase` | One rule for every upgrade: unlocked at a Level, then bought with coins (section 11). |
| Queue with stored end times | a facility's jobs | Jobs run in start order, and work in flight keeps its end time (section 12). |
| Strategy | `StepSource` | Each feature adds its automated steps without changing `advance` (section 12). |
| Shared module for a repeated rule | `storage/` | Put and take are written once for harvests, jobs, feeding, collecting from pens and delivering orders (sections 12, 13, 15). |
| Discriminated union per animal, stored end time | a pen's animals | Each animal eats and produces on its own, and work in flight keeps its end time (section 13). |
| Level-triggered automated steps | the Collector, the Loop | The Collector acts a ms after waiting goods fit and the Loop whenever a slot and the inputs are there, so a slot or room freed by any step or action is used at once or at the next ms, never behind a step already run; the queue alone limits a Loop (section 16). |
| Table-driven rules | a facility's tier rows | Each tier's price, slots and job time is a row of content, so tuning or adding a tier changes no code (section 14). |
| Discriminated union per slot, stored end time | the order board | Each slot is open or refilling at a time fixed when it emptied (section 15). |
| Seeded draw from a pool filtered first | drawing an order | MUST-04.3 holds at every draw in a fixed number of draws (section 15). |
| Notification, table-driven validation | `checkContent` | Every broken rule comes back as data in one run, and each rule is one function a test can break alone (section 17). |

## Consequences

- **Every caller creates the sim from content.** The server handler, `replay` (ADR-0001) and the
  client each call `createSim(content)` once and use what it returns. Store code still never
  imports the sim: the factory hands `replay` and `newFarm` in.
- **#31 can be decided later** without changing the state: a rules version is a content object.
  (Decided 11 Nov in [ADR-0006](0006-rules-versions-and-replay.md); the state still has no
  version field.)
- **A refusal returns no state.** The handler answers 422 on `{ ok: false }` (ADR-0001's second
  `processed` check comes first) and keeps the farm it loaded.
- **The state hash is one pure, synchronous function** for client and server. It encodes strings
  to UTF-8 itself, since `TextEncoder` isn't in the ES lib that the purity guard allows.
- **Content expresses curves as integers** (section 10): a multiplier or growing cost is a
  per-mille value or similar, applied with floor division.
- **The state is the persisted format.** Adding or changing a field in the state or action types,
  or an export, meets `CONSTRAINTS.md`'s "Interface change" row and carries `review:admin`.
- **MUST-07.4 is 30 days**, as in `CONSTRAINTS.md`. The bench in the `advance` ticket's PR is the
  first measurement; #41 makes it a check in M3.
- **Decided 11 Nov (#31):** how logs stay replayable after a rules change: a registry of rules
  versions, each a frozen content object ([ADR-0006](0006-rules-versions-and-replay.md)).
