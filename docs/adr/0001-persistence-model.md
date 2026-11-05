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
load → advance(state, at) → apply(state, action, at) → commit → on conflict: retry (max 3)
```

```ts
type FarmRecord = { state: FarmState; seq: number; at: number }; // after action `seq`, not advanced

interface GameStore {
  load(playerId: string): Promise<FarmRecord>;
  commit(playerId: string, entry: {
    expectedSeq: number;      // the seq that was loaded; the commit writes expectedSeq + 1
    action: Action;
    at: number;
    idempotencyKey: string;
    next: FarmState;          // A always writes it; B writes it only as a snapshot
    inbox?: { send: Gift } | { claim: string };
  }): Promise<
    | { kind: "committed"; seq: number }
    | { kind: "duplicate"; seq: number }
    | { kind: "conflict" }
  >;
}

interface AuditableStore extends GameStore {
  stateAt(playerId: string, t: number): Promise<FarmState>; // B only
}
```

Every store checks what it loads before returning it: `seq` and `at` must be safe integers
(`Number.isSafeInteger`), or `load` throws a store error. Postgres drivers return `bigint`
columns as strings by default, and a string `at` would otherwise reach the state hash and look
like a simulation bug. The driver is also configured to parse `bigint` as a number, but the
check at the boundary is the guard; the driver setting is only a convenience.

Gifts use a shared inbox table outside the comparison. Sending a gift is the sender's action and
inserts the gift (id `<senderId>:<seq>`); claiming it is the recipient's action, whose payload the
server fills with the gift's goods before `apply`, so a farm's replay never needs another farm's
data. Inbox writes run in the same transaction as the commit. No action ever writes two farms.

### Patterns

| Pattern | Where | Why |
| --- | --- | --- |
| Repository | `GameStore` | SQL stays behind farm-shaped methods; the handler never sees tables. |
| Strategy (+ factory) | A, B1, B25, B100 | Interchangeable stores chosen once from `STORE` and `SNAPSHOT_N`. |
| Functional core, imperative shell | handler + sim | The sim stays pure; only the handler does I/O. |
| Optimistic Offline Lock | `expectedSeq` | A conflict is detected at commit and retried, no lock held across the sim. |
| Idempotent Receiver | `idempotencyKey` | A retried request returns the first answer instead of applying twice. |
| Event Sourcing + Snapshot | B | Actions are the source of truth; snapshots bound replay length. |
| Interface Segregation | `AuditableStore` | A cannot audit, so it doesn't pretend to. |

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

## Decision rule (fixed before measuring)

1. **Gate.** First, a round-trip check per store: commit a farm, load it back, and require a
   strict deep-equal (types included) with the in-memory farm, so a type mismatch shows up as a
   store bug before any hash is compared. Then the same 500 scripted actions (including an 8-hour gap and some invalid actions)
   give an identical state hash in A, every B and the in-memory sim, and B's `stateAt` matches
   the sim at 10 random times. A failure is a bug to fix, not an input to the decision.
2. **B wins unless** either holds for a B variant:
   - at 200 players, its p95 action latency > max(2 × A's p95, A's p95 + 20 ms);
   - for B100, the worst-case load (snapshot plus a 99-action tail, read and replay, timed
     server-side) has p95 > 50 ms.
3. **Among passing B variants**, the lowest p95 at 200 players wins; if two are within 5 ms, the
   one with fewer bytes per player-hour wins. If none pass, A wins.
4. Storage, offline-return latency, auditability and complexity are reported, not gates. Replay
   cost is also reported in µs per action and projected at 10× for the full sim.

**Timebox.** If the full Locust matrix isn't done by Sat 7 Nov 22:00, one run per configuration
counts. If the gate still fails at Sat 18:00, A is chosen provisionally and determinism is
followed up in M2.

## Method

A `node:http` spike server (`STORE=A|B`, `SNAPSHOT_N=1|25|100`) on a tiny sim (6 wheat plots, a
bakery with a 3-job queue run one after another, a seeded bonus yield, gifts) against local
Supabase Postgres, one schema per store. Locust 2.47.0 runs 50 and 200 players (80% active with
2–8 s between taps, 20% returning after 8 hours via a spike-only clock-offset header), each
player seeded with about 1,000 actions, 1 min warm-up plus 5 min measured, 3 runs per
configuration, plus one stress run per store. A concurrency script fires a gift and a harvest at
one farm at the same moment 1,000 times per store. Everything runs on one WSL2 laptop. Code
lives on `prototype/persistence` and is not merged; results are in `docs/spikes/persistence/`.

## Results

_To be filled from `docs/spikes/persistence/results.csv`._

| | A | B1 | B25 | B100 |
| --- | --- | --- | --- | --- |
| Gate (hash equivalence) | | | | |
| p50 / p95 at 50 players (ms) | | | | |
| p50 / p95 at 200 players (ms) | | | | |
| Worst-case load p95 (ms) | | | | |
| Offline return p95 (ms) | | | | |
| Lost updates / retries / 503s | | | | |
| Bytes per player-hour | | | | |
| `stateAt` possible | no | | | |
| Lines / moving parts | | | | |

## Decision

_Pending results._

## Consequences

_Pending results. Whichever wins, the clamp `at = max(serverNow, lastAt)` stays in the real API
so a farm's time never runs backwards across server instances._
