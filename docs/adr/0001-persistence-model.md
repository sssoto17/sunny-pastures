---
status: proposed
---

# Persistence model: one state row or an action log with snapshots

Every action and every return after time away has to load a farm, bring it up to server time,
apply the action and save it, and stay correct when two requests for one farm overlap. Before any
real schema exists (M3) we compare two ways to store a farm with a throwaway spike, and let
measurements chosen in advance pick the winner. This draft fixes the candidates, the store
interface and the decision rule before the first measurement runs; the Decision section is filled
in from the results.

## Candidates

- **A, state row.** One row per farm holding its state, its sequence number and the time of its
  last action, overwritten on every accepted action. History is lost on each write.
- **B, action log with snapshots.** Every accepted action is appended to a per-farm log keyed by
  sequence number; the state is a cache rebuilt by replaying the log from the latest snapshot.
  Three snapshot intervals are measured:
  - **B1**: one latest snapshot per farm, overwritten on every action (log plus state row).
  - **B25** and **B100**: a snapshot is kept after every 25th or 100th action.

Both compute offline progress lazily: nothing runs while a player is away; the next request
advances the farm to server time in memory. Reads never write.

## Store interface

The store persists; it never runs the simulation. The server handler owns the loop:

```
processed? → load → advance(state, at) → apply(state, action, at) → commit → on conflict: retry (max 3)
```

```ts
type FarmRecord = { state: FarmState; seq: number; at: number }; // after action `seq`, not advanced
type Answer = { seq: number; hash: string; rebased: boolean; retries: number }; // the POST response

interface GameStore {
  load(playerId: string): Promise<FarmRecord>;
  processed(playerId: string, idempotencyKey: string): Promise<Answer | null>;
  commit(playerId: string, entry: {
    expectedSeq: number;      // the seq that was loaded; the commit writes expectedSeq + 1
    action: Action;
    at: number;
    idempotencyKey: string;
    next: FarmState;          // A always writes it; B writes it only as a snapshot
    answer: Answer;           // stored with the key, returned unchanged for a repeat
  }): Promise<
    | { kind: "committed"; seq: number }
    | { kind: "duplicate"; answer: Answer }
    | { kind: "conflict" }
    | { kind: "refused"; reason: string } // the inbox refused the gift write; nothing committed
  >;
  gift(giftId: string): Promise<Gift | null>;
}

interface AuditableStore extends GameStore {
  // B only. The farm at server time t: the actions up to t, then advanced to t. `seq` is the
  // last action at or before t (0 before the first), so an audit can say which one it saw.
  stateAt(playerId: string, t: number): Promise<{ state: FarmState; seq: number }>;
}
```

The audit route refuses a `t` later than server time (400): `stateAt` reads history, not a
forecast. B's `load` doesn't compare the replayed hash with the last log row's answer hash. The
gate covers determinism, and a per-load hash would add work to B's measured `load` that A doesn't
do. (Amended 6 Nov after #9.)

Every store checks what it loads before returning it: `seq` and `at` must be safe integers
(`Number.isSafeInteger`), or `load` throws a store error. Postgres drivers return `bigint`
columns as strings by default, and a string `at` would otherwise reach the state hash and look
like a simulation bug. The driver is also configured to parse `bigint` as a number, but the
check at the boundary is the guard; the driver setting is only a convenience.

A farm with no accepted action loads as `{ state: newFarm, seq: 0, at: 0 }`. The store is given a
`newFarm(playerId)` function when it is created; that builds content, it doesn't run the
simulation. The farm's PRNG seed comes from its id, so a new farm is the same on every server.

**Proposed (#7):** store B is also given `replay(state, actions, to)` when it is created, the same
way it gets `newFarm`. It applies the actions in seq order, each at its own `at`, then advances to
`to`. B's `load` and `stateAt` call it, but store code never imports the sim: the factory hands it
in. If the rules refuse a logged action, `replay` throws instead of skipping it.

A repeated idempotency key returns the first answer. The handler asks `processed` before it runs
the simulation, because a resent action may no longer be valid (a resent "plant plot 0" finds the
plot already growing) and would otherwise get a 422 instead of its first answer. The handler
builds the full answer before it commits, and the commit stores it with the key in the same
transaction, so a duplicate returns it unchanged: A keeps no history to rebuild an old hash from.
The commit claims the key before it writes the farm and rolls the claim back on a conflict, so a
lost race doesn't use up the key. (Amended 6 Nov after the tracer bullet, #5.)

`processed` can miss a resend that races its own first commit: it runs before that commit, and
the load runs after it, so the rules refuse the action. Before any 422, the handler asks
`processed` again and returns the first answer if one is there now. (Amended 6 Nov after #8.)

Gifts use one inbox table shared by every store, in its own schema, outside the comparison. The
factory hands each store the inbox when it is created, as it does `newFarm`. The store derives the
inbox write from the committed action, so the two can't disagree: a `sendGift` inserts gift
`<playerId>:<seq>`, and a `claimGift` marks its gift claimed only if it is the claimer's, unclaimed
and holds the claimed goods. The write runs in the commit's transaction, after the farm write, so
a race on one farm shows up as a conflict (and a retry) first. If the inbox refuses, the commit
rolls back and returns `{ kind: "refused"; reason }`, and the handler answers 422 with no seq, key
or gift row used. `GameStore` gains `gift(giftId)`, so the handler can fill a claim's goods before
`apply`; the client never sends them. A farm's replay never needs another farm's data. No action
ever writes two farms. (Amended 6 Nov after #8.)

### Patterns

| Pattern | Where | Why |
| --- | --- | --- |
| Repository | `GameStore` | SQL stays behind farm-shaped methods; the handler never sees tables. |
| Strategy (+ factory) | A, B1, B25, B100 | Interchangeable stores chosen once from `STORE` and `SNAPSHOT_N`. |
| Functional core, imperative shell | handler + sim | The sim stays pure; only the handler does I/O. |
| Optimistic Offline Lock | `expectedSeq` | A conflict is detected at commit and retried, no lock held across the sim. |
| Idempotent Receiver | `idempotencyKey`, `processed` | A retried request returns the stored first answer instead of applying twice. |
| Event Sourcing + Snapshot | B | Actions are the source of truth; snapshots bound replay length. |
| Interface Segregation | `AuditableStore` | A cannot audit, so it doesn't pretend to. |
| Shared gateway, injected | inbox | One table and its SQL for all stores, handed in by the factory so every store writes gifts the same way. |

### Alternatives considered

- **The store runs `apply` itself, like a command handler.** Rejected: each store would call the
  sim, which couples persistence to the rules.
- **Active Record.** Rejected: a state that saves itself mixes rules and I/O, which the sim's
  zero-dependency boundary forbids.
- **Pessimistic locking** (`SELECT … FOR UPDATE`, advisory locks per farm). Rejected: it holds a
  lock across the sim call and serialises reads too.
- **Template Method base class for the stores.** Rejected: the stores share almost no steps.
- **Direct gift delivery** (writing into the recipient's farm in the sender's transaction).
  Rejected: it needs lock ordering across two farms and puts actions the recipient never chose
  into their history.
- **The client resolves conflicts** (409 and resend). Rejected: two open tabs would keep failing
  each other's requests.
- **An event-store library** instead of a hand-built log: deferred (COULD-04).
- **An `inbox` field on the commit entry** (this ADR's first draft). Rejected after #8: it is a
  second description of the action that could disagree with it.
- **Inbox writes outside the commit's transaction.** Rejected: a crash between the two writes
  would lose a gift or claim one twice.
- **Duplicate detection only inside `commit`, returning the first `seq`** (this ADR's first
  draft). Rejected after #5: a resent action the rules now refuse never reaches `commit`, and A
  can't rebuild the first answer's hash from a `seq`.
- **`load(playerId, idempotencyKey)` returning any stored answer with the farm.** Rejected: one
  round trip fewer, but `load` would do two jobs.

## Decision rule (fixed before measuring)

1. **Gate.** Step 0, with no database: the in-memory sim runs the 500-action script twice and
   replays it from in-memory snapshots at N = 1, 25 and 100, and every run must give the same
   hash. This step decides where any later failure lies: if it fails, the sim is at fault; if
   it passes but a store fails a later step, that store's code is at fault.
   Next, a round-trip check per store: commit a farm, load it back, and require a
   strict deep-equal (types included) with the in-memory farm, so a type mismatch shows up as a
   store bug before any hash is compared. Then the same 500 scripted actions (including an 8-hour gap and some invalid actions)
   give an identical state hash in A, every B and the in-memory sim, and B's `stateAt` matches
   the sim at 10 random times and at the middle of the script's 8-hour gap, so offline progress
   is audited on every seed (amended 6 Nov after #9; the random times land in the gap only about
   once in 50). A failure is a bug to fix, not an input to the decision.
2. **B wins unless** either holds for a B variant:
   - at 200 players, its p95 action latency > max(2 × A's p95, A's p95 + 20 ms);
   - for B100, the worst-case load (snapshot plus a 99-action tail, read and replay, timed
     server-side) has p95 > 50 ms.
3. **Among passing B variants**, the lowest p95 at 200 players wins; if two are within 5 ms, the
   one with fewer bytes per player-hour wins. If none pass, A wins.
4. Storage, offline-return latency, auditability and complexity are reported, not gates. Replay
   cost is also reported in µs per action and projected at 10× for the full sim.

**Timebox.** The spike runs on Fri 6 Nov plus a second spike day, Sat 7 or Sun 8 Nov, whichever
Soto works. On the second spike day the gate cut-off is 18:00 and the matrix cut-off is 22:00.
If the full Locust matrix isn't done by the matrix cut-off, one run per configuration counts. If
the gate still fails at the gate cut-off, what happens depends on where the failure is traced. A failure in the sim (non-determinism) means A is chosen provisionally, because A doesn't
rely on replay, and determinism is followed up in M2. A failure in one store's own code takes
only that store out of the comparison until it's fixed; the rule then decides among the rest.

## Method

A `node:http` spike server (`STORE=A|B`, `SNAPSHOT_N=1|25|100`) on a tiny sim (6 wheat plots, a
bakery with a 3-job queue run one after another, a seeded bonus yield, gifts) against local
Supabase Postgres, one schema per store. Locust 2.47.0 runs 50 and 200 players (80% active with
2–8 s between taps, 20% returning after 8 hours via a spike-only clock-offset header), each
player seeded with about 1,000 actions, 1 min warm-up plus 5 min measured, 3 runs per
configuration, plus one stress run per store. A concurrency script fires a gift and a harvest at
one farm at the same moment 1,000 times per store. Everything runs on one WSL2 laptop. Locust,
the spike server and Postgres run on the same machine, wherever the matrix runs: a network hop
between Locust and the server would add the same delay to A and B, and the 2× term of the
decision rule would loosen by that delay in B's favour. B1's snapshot table is keyed by farm
and upserted on every action, like A's state row, while B25 and B100 key snapshots by (farm, seq);
that keeps B1's per-action write comparable with A's (#7). Code
lives on `prototype/persistence` and is not merged; results are in `docs/spikes/persistence/`.

**Load-run controls (#10).** The spike server exposes them only with `SPIKE_CLOCK=1`:
`X-Spike-Clock-Offset` (non-negative ms added to server time; the `max(now, lastAt)` clamp still
applies), `POST /spike/seed` and `GET /spike/storage`. Every response carries `Server-Timing`:
**load** (store reads, including B's replay, the idempotency check and the gift lookup),
**commit** (the commit transaction), **sim** (the rest of the handler) and **total**, written to a
server CSV with the same numbers; a Decorator around `GameStore` measures them, so neither the
handler nor the stores carry timing code. Players are seeded through the store's own commit path,
player *i* with 1,000 + (*i* × 37) mod 100 actions, so replay tails spread across 0 to N−1. An
active player whose plots are all growing spends the tap on a GET. Locust runs from its own uv
project (uv, Python and Locust pinned; `exclude-newer` 7 days back), and its final stats come
from `--json-file`, because the stats CSV is a periodic snapshot. The server's keep-alive timeout
(65 s) exceeds the longest client wait, so idle connections aren't closed mid-reuse.

## Results

_To be filled from `docs/spikes/persistence/results.csv`._ The gate row is from
`docs/spikes/persistence/gate.md` (#9): seed 42, every store ends on hash `e1925b02…` at seq 456
with 456/456 strict round trips, and every B's `stateAt` matches the sim 11/11 (10 random times
plus the middle of the 8-hour gap, #15). Identical on the
cloud container (Postgres 16) and the laptop (Postgres 17).

| | A | B1 | B25 | B100 |
| --- | --- | --- | --- | --- |
| Gate (hash equivalence) | pass | pass | pass | pass |
| p50 / p95 at 50 players (ms) | | | | |
| p50 / p95 at 200 players (ms) | | | | |
| Worst-case load p95 (ms) | | | | |
| Offline return p95 (ms) | | | | |
| Lost updates / retries / 503s | | | | |
| Bytes per player-hour | | | | |
| `stateAt` possible | no | yes | yes | yes |
| Lines / moving parts | | | | |

## Decision

_Pending results._

## Consequences

Whichever store wins:

- The clamp `at = max(serverNow, lastAt)` stays in the real API, so a farm's time never runs
  backwards across server instances.
- **Open M2 decision: where the state hash lives.** The spike hashes with SHA-256 from
  `node:crypto`. The real `packages/sim` can't import it (zero runtime dependencies, no `node:*`
  imports), and the browser's `crypto.subtle` is async. So in M2 the state hash either moves out
  of the sim into the server and client code around it, or becomes a small pure-TypeScript hash
  inside the sim.

_Consequences that depend on the decision follow with the results._
