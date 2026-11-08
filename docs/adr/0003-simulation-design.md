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
time, MUST-10.6's key breaks the tie: time, then kind of automated step, then facility, pen or plot
index, then queue slot. The key is defined once in the sim. `apply` advances to `at` first, then
applies the action.

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

Each property runs 100 times at task end and 1,000 times in CI. The tests read the count from
`SIM_PROPERTY_RUNS`, which `ci / test` sets (#40).

**Pattern:** property-based testing (fast-check, fixed seed).

**Rejected:**

- **Example-based tests only.** They can't reach the generated tie and storage cases that
  MUST-14.8 needs.
- **A fresh random seed per run.** A failure couldn't be reproduced, and CI would flake.

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

## Consequences

- **Every caller creates the sim from content.** The server handler, `replay` (ADR-0001) and the
  client each call `createSim(content)` once and use what it returns. Store code still never
  imports the sim: the factory hands `replay` and `newFarm` in.
- **#31 can be decided later** without changing the state: a rules version is a content object.
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
- **Open:** how logs stay replayable after a rules change (#31), due before M3's schema.
