# Requirement specification

What Sunny Pastures must do for each item in [`moscow.md`](moscow.md), written so each criterion can
be checked. `moscow.md` ranks the scope; this file says when an item is done. It is also the
starting point for the report's requirements chapter and for planning M2–M4.

Status: **draft**. Points still open are marked _Open_ and listed under
[Open questions](#open-questions). The grill behind it is on issue #2.

Last changed: 2026-11-06.

## Objective

The research question (see `AGENTS.md`): how can the game's progression be modelled as one
deterministic simulation that runs on both client and server, so progress continues offline and
stays consistent and cheat-resistant, and how does that affect the player experience?

The game is a cosy farm and bakery idle game. At the start everything is manual: the player plants,
feeds, bakes and collects. Upgrades gradually automate the farm, so that more and more of it keeps
producing while the player is away. That gradual automation is the gameplay, and it is also what
gives offline progress something to compute.

**Actors**

- **Player**: plays one farm in one browser and has no account form to fill in.
- **Friend**: another player, connected to this one through an invite.
- **Server**: owns server time and the rules' verdict on every action.
- **Admin**: Soto, who owns the repo, the content data and the playtests.
- **Agent**: a coding agent that opens PRs. Agents can't change the acceptance tests.

Words in **bold** in the criteria, and the terms they use, are defined in [`GLOSSARY.md`](../../GLOSSARY.md).

## How to read this spec

- Each section is one MoSCoW item, and its criteria are numbered `<ID>.<n>`, such as `MUST-01.3`.
  Issues, PRs and tests refer to criteria by that number.
- **Numbers live in content data, not in this spec.** Content data covers grow times, prices,
  yields, XP, Level thresholds, capacities and delays. It sits next to the simulation in
  `packages/sim` and is tuned after playtest 1. A criterion that says "per content" means its test
  reads the value from content data instead of hard-coding it. This spec fixes only what exists,
  how it connects and the bounds that tests rely on.
- **"Depends on ADR-0001"** marks a criterion that needs farm history: actions from before the
  farm's last action. Whether that history exists depends on the persistence model decided in
  #12. These criteria are settled after #12. Everything untagged holds for either store.
- **Already settled, not reopened here:** offline progress is computed lazily: nothing runs while
  a player is away, and the next request brings the farm up to server time. Determinism,
  sequence numbers and idempotency keys come from the persistence spike (ADR-0001, #5–#11).

### Verified by

| Tag | Meaning |
| --- | --- |
| `unit` | Example-based test of the simulation in `packages/sim` |
| `prop` | Property-based test of the simulation (MUST-14) |
| `bench` | Benchmark of the simulation, run in CI against a budget |
| `content` | Validation test over the content data |
| `accept` | Black-box acceptance test over HTTP in `tests/acceptance/` (MUST-15) |
| `attack` | Cheat-attack test for a threat in the threat model (MUST-16) |
| `ui` | Test in a real browser. _Open_: the tool, which is a new dependency |
| `ci` | A CI step, ruleset or repo setting that enforces it |
| `playtest` | Observed in playtest 1 or 2 (MUST-18) |
| `metric` | Measured and reported (MUST-19) |
| `review` | Checked by the admin in review |

### Where the rest of the spec lives

The commands, project structure, code style and boundaries (always / ask first / never) are in
`AGENTS.md`, and in `CONSTRAINTS.md` once that exists. This spec doesn't repeat them. Architecture decisions are in
`docs/adr/`.

## Decisions from review

These were not asked directly in the grill. They were proposed as defaults in the draft and confirmed by
the admin in review on 6 Nov.

1. A facility, an animal pen or a farmhand becomes **unlocked** at a Level, then has to be bought
   with coins before it exists on the farm. It follows the same rule as tiers and storage.
2. An order is delivered whole or not at all. There are no partial deliveries.
3. Removing a friend doesn't cancel gifts already sent: an unclaimed gift stays claimable.
4. A facility's job keeps its queue slot until its goods are collected, as in the spike's bakery.
5. A new farm starts at Level 1 with some coins, a few plots, wheat unlocked and no automation:
   troughs hold one portion, and there are no add-ons and no farmhands.

## Must have: gameplay

### MUST-01 Crops

Wheat, corn and strawberries: plant, grow over time, harvest.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-01.1 | Planting an **unlocked** crop on an empty plot costs that crop's seed price in coins. It is refused if the plot isn't empty, the crop isn't unlocked or the farm has too few coins. | `unit`, `accept` |
| MUST-01.2 | A crop is ready exactly its grow time (per content) after the server time of the planting action. Harvesting before then is refused. | `unit`, `prop` |
| MUST-01.3 | Harvesting puts the yield in the **silo**, empties the plot and gives XP. It is refused if the silo can't hold the whole yield. | `unit`, `accept` |
| MUST-01.4 | The yield is the base yield plus a bonus drawn from the farm's seeded randomness. The same farm, actions and times always give the same yield. | `prop` |
| MUST-01.5 | Wheat is unlocked at Level 1. Corn and strawberries unlock at the Levels set in content. | `content` |

### MUST-02 Animals

Chickens and cows: feed, produce over time, collect.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-02.1 | Chickens eat chicken feed and produce eggs. Cows eat cow feed and produce milk. | `content` |
| MUST-02.2 | Feeding moves feed from the **barn** into a pen's **trough**, up to the trough's capacity. It is refused if the barn holds no feed of that kind or the trough is full. | `unit`, `accept` |
| MUST-02.3 | While its trough holds feed, each animal eats one portion and produces one product after its production time. It then eats the next portion if there is one. This goes on without the player, including while they are away. | `unit`, `prop` |
| MUST-02.4 | Products wait in the pen until collected. Collecting moves them to the barn and gives XP. It is refused if the barn can't hold them all. | `unit`, `accept` |
| MUST-02.5 | At the start a trough holds one portion, so each product takes one feeding. Larger troughs are an upgrade (MUST-06.3). | `content` |

### MUST-03 Production facilities

The feed mill, the bakery and the dairy, each with a timed queue.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-03.1 | The recipes, and the **tier** at which each becomes available: feed mill: tier 1 chicken feed, tier 2 cow feed. Dairy: tier 1 cream, tier 2 butter, tier 3 cheese. Bakery: tier 1 bread, tier 2 cookies, tier 3 strawberry cake. Inputs, outputs and times are per content. | `content` |
| MUST-03.2 | Starting a **job** needs the recipe available at the facility's current tier, a free queue slot and every input in storage. The inputs leave storage when the job starts. Otherwise it is refused. | `unit`, `accept` |
| MUST-03.3 | Jobs run one after another in the order they were started. A job finishes at the later of its start and the previous job's finish, plus the recipe's duration at the tier the facility had when the job started. | `unit`, `prop` |
| MUST-03.4 | Finished goods wait in the facility until collected. Collecting moves them to the barn and gives XP. It is refused if the barn can't hold them. | `unit`, `accept` |
| MUST-03.5 | A job keeps its queue slot until its goods are collected. The number of slots follows the facility's tier (MUST-06.2). | `unit` |
| MUST-03.6 | Every crop and every animal product is an input to at least one recipe, and strawberry cake needs goods from crops, animals and the dairy. | `content` |

### MUST-04 Order board

Deliver goods to non-player characters for coins and XP.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-04.1 | The **order board** has the number of slots the player's Level gives, per content: 3 at Level 1 and at most 9. The number never goes down. | `content`, `unit` |
| MUST-04.2 | Each order asks for 1–3 kinds of **unlocked** goods in set quantities, and pays coins and XP. Orders are drawn from the farm's seeded randomness, so the same farm, actions and times give the same orders. | `unit`, `prop` |
| MUST-04.3 | At most one open order asks for a good that isn't **producible** when the order is drawn. | `prop` |
| MUST-04.4 | Delivering an order takes all of its goods from storage and pays its coins and XP. It is refused if any good is short. | `unit`, `accept` |
| MUST-04.5 | A delivered order's slot fills again after the refill delay for the player's Level. A discarded order's slot fills again after a longer delay. Both delays are per content, and neither gets longer as Level rises. | `unit`, `content` |
| MUST-04.6 | Slots refill on server time, including while the player is away. | `prop` |

Skipping a refill delay is SHOULD-06.

### MUST-05 Economy and progression

Coins, XP and Levels that unlock content.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-05.1 | Coins never go below zero. Any action that would spend more than the farm has is refused. | `prop`, `accept` |
| MUST-05.2 | Delivering orders earns XP (most of it), and so do harvesting and collecting (a little each), per content. XP never goes down. | `unit`, `prop` |
| MUST-05.3 | A farm's Level follows from its XP through the Level table in content. Levels never go down. | `unit`, `content` |
| MUST-05.4 | Reaching a Level unlocks what the Level table lists for it and pays its level-up coins. When one action crosses several Levels, each Level's unlocks and coins apply once. | `unit` |
| MUST-05.5 | The Level table covers crops, animals, facilities, recipes, tiers, add-ons, plots, storage capacity, troughs and order slots. Everything in the content is reachable through it. | `content` |
| MUST-05.6 | **Unlocked** means allowed, not owned. An unlocked upgrade, facility, pen or capacity exists on the farm only after the player buys it. | `unit` |

### MUST-06 Upgrades

Upgrades for fields, facilities, pens and storage, and the first automation.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-06.1 | **Fields**: extra plots can be bought. Each plot costs more than the one before, and the maximum number of plots depends on Level. | `unit`, `content` |
| MUST-06.2 | **Facility tiers**: a tier upgrade costs coins and needs a minimum Level. Each tier shortens job times. Every 2nd tier adds a queue slot, up to a maximum. Facilities go up to tier 5, and tiers 4–5 bring only speed and slots. | `unit`, `content` |
| MUST-06.3 | **Pens**: trough capacity and the number of animals per pen can be upgraded. | `unit`, `content` |
| MUST-06.4 | **Storage**: the **silo** (crops) and the **barn** (all other goods) each have a capacity. Larger capacities unlock with Level and are bought with coins. | `unit`, `content` |
| MUST-06.5 | **Loop** add-on: when the facility has a free slot and the inputs are in storage, it starts the facility's last recipe again. This includes while the player is away. It stops when inputs or space run out. | `unit`, `prop` |
| MUST-06.6 | **Collector** add-on: it moves a facility's finished goods into storage as soon as they're done, if they fit. If they don't fit, they wait in the facility. | `unit`, `prop` |
| MUST-06.7 | An upgrade applies only to jobs, crops and production started after it was bought. Anything already running keeps its finish time. | `unit`, `prop` |
| MUST-06.8 | A new farm has no automation: troughs hold one portion, and there are no add-ons. | `unit` |

### MUST-07 Offline progress

The farm keeps producing while the player is away.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-07.1 | While the player is away, the farm does what it would have done if they had watched: crops ripen, jobs finish in order, animals eat from troughs, Loop and Collector work and order slots refill. Advancing in one step or in many gives the same farm (MUST-14, invariant 1). | `prop` |
| MUST-07.2 | Automated production stops when its output wouldn't fit in storage, or when inputs or coins run out. Storage capacity is the only bound: there is no time-based cap on offline progress. | `unit`, `prop` |
| MUST-07.3 | **Away summary since the last action**: on return, the client shows what changed since the farm's last accepted action. It lists counts per good and a timeline of what happened, with server times ("03:12 the bakery finished 3 cookies"). The summary comes from advancing the farm, so client and server produce the same one. | `unit`, `ui`, `playtest` |
| MUST-07.4 | Advancing the most-automated farm the content allows by 7 days takes < 50 ms on the server. That farm has max tiers, every add-on, full troughs and farmhands (if SHOULD-05 ships). | `bench` |
| MUST-07.5 | **Depends on ADR-0001.** An away summary "since you last looked", reaching back across actions made in between (in another tab, by farmhands). | _after #12_ |

### MUST-08 Gifting

Send goods to a friend.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-08.1 | On first play, a player picks a display name. Display names don't have to be unique. | `ui` |
| MUST-08.2 | A player adds a **friend** by sharing an invite link, or its code as a fallback. The other player accepts, and from then on the two are friends both ways. Either side can remove the friendship. There is no player search. | `accept` |
| MUST-08.3 | A **gift** can go only to a friend and holds only goods: never coins, never clovers. The goods leave the sender's farm when it is sent. Sending is refused if the sender doesn't hold them. | `unit`, `accept`, `attack` (T9) |
| MUST-08.4 | The goods reach the recipient only when the recipient **claims** the gift. A claim is refused if storage can't hold the goods, and the gift stays in the inbox. | `accept` |
| MUST-08.5 | Only the recipient can claim a gift, and only once. | `attack` (T6) |
| MUST-08.6 | A sender can send at most N gifts per server day, and a recipient's inbox holds at most M unclaimed gifts. Both numbers are per content. Sending is refused at either limit. Gifts don't expire. | `accept`, `attack` (T9) |
| MUST-08.7 | A player can see their gift history: what they sent, what they received and what has been claimed. It is read from the gift inbox, so it doesn't need farm history. | `accept` |

### MUST-09 Play without a sign-up form

Supabase anonymous sign-in.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-09.1 | A first visit creates an anonymous user and a new farm without asking for anything but a display name. | `accept`, `ui` |
| MUST-09.2 | Returning in the same browser opens the same farm. | `ui` |
| MUST-09.3 | The UI tells the player that the farm lives in this browser until they link an email (SHOULD-04). | `ui`, `review` |
| MUST-09.4 | Every game request is authenticated, and no request can read or change a farm other than the caller's. A visit (SHOULD-01) reads, and never writes. | `attack` (T5) |

## Must have: system qualities

### MUST-10 One deterministic simulation

`packages/sim`, shared by client and server.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-10.1 | `packages/sim` has zero runtime dependencies. It does no I/O, never calls `Date.now()` or `Math.random()` and imports nothing from `node:*`. A CI check enforces this, rather than review. | `ci` |
| MUST-10.2 | Client and server run the same simulation code. Given the same farm, actions and times, both reach the same state hash. | `prop` |
| MUST-10.3 | All randomness comes from the farm's seeded PRNG, and the seed comes from the farm's id. | `prop`, `review` |
| MUST-10.4 | Content is data inside the simulation. A content test checks it:<br>• every timer is a whole number of seconds between 10 s and 24 h;<br>• every recipe input can be produced by some unlocked route;<br>• every unlock refers to content that exists;<br>• Level thresholds rise strictly. | `content` |
| MUST-10.5 | _Open (from ADR-0001):_ where the state hash is computed: outside the simulation in server and client code, or as a small pure-TypeScript hash inside it. Decided in M2. | `review` |
| MUST-10.6 | When several things happen at the same moment and share storage, the simulation handles them in one fixed order. Examples: a Collector filling the barn, a Loop restart, a trough refill, an order slot refilling. The order is first by kind of event, then by facility, pen or plot index, then by queue slot. It is defined once in the simulation and never depends on the order of a map, a set or a request, so client and server always choose the same order. | `unit`, `prop` |

### MUST-11 Server authority

Server time and server-side validation of every action.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-11.1 | The server stamps every action with **server time**. A request carries no time and no result. If a request includes them anyway, they are ignored or the request is rejected. | `attack` (T1, T2) |
| MUST-11.2 | The server runs every action through the simulation. A refused action gets a 422 with a reason, and it uses no sequence number and leaves the farm unchanged. | `accept` |
| MUST-11.3 | An action's time is `max(server time, the farm's last action time)`, so a farm's time never runs backwards across server instances. | `unit`, `attack` (T1) |
| MUST-11.4 | A claim's goods come from the gift inbox on the server, never from the client. | `attack` (T2, T6) |
| MUST-11.5 | Reads never write: loading or visiting a farm stores nothing. | `accept` |

### MUST-12 Prediction and reconciliation

Optimistic client prediction, reconciled with the server's result.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-12.1 | After a tap, the **prediction** shows within 100 ms, before the server answers. | `ui` |
| MUST-12.2 | When the server answers, the client takes the server's farm and applies its own still-unconfirmed actions on top of it again (**reconciliation**). | `unit`, `ui` |
| MUST-12.3 | When the server refuses a predicted action, the prediction is undone and the player sees a short, friendly reason ("Not ready yet"). | `ui` |
| MUST-12.4 | When the server's outcome differs silently from the prediction (a different bonus roll, say), the client snaps to it without a message, and the difference counts in the reconciliation metric (MUST-19.2). | `unit`, `metric` |
| MUST-12.5 | A request in flight is retried with the same idempotency key. If the connection is lost, the UI shows "reconnecting" and blocks new actions. There is no play without a connection (WONT-07). | `ui` |
| MUST-12.6 | With two tabs open on one farm, each tab ends up showing the server's farm after its next response. | `ui` |

### MUST-13 Persistence

Survives concurrent actions and retries. The model is decided by ADR-0001 (#12), and these
criteria hold for either store.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-13.1 | Every accepted action gets the farm's next sequence number, with no gaps. | `accept` |
| MUST-13.2 | Resending an idempotency key returns the first answer unchanged, even when the action would now be refused. | `accept`, `attack` (T3) |
| MUST-13.3 | Concurrent actions on one farm never lose an update. A conflict is retried (at most 3 times). After that the request fails with a 503 and nothing is committed. | `accept`, `attack` (T4) |
| MUST-13.4 | Sending a gift, and claiming one, is written in the same transaction as the farm. No gift is lost or claimed twice, even across a crash. | `accept`, `attack` (T4, T6) |
| MUST-13.5 | The spike's concurrency check runs against the real store: 1,000 gift-and-harvest pairs fired at one farm at the same moment, with no lost update. | `accept` |

### MUST-14 Property tests for the simulation

Randomly generated farms, action sequences and times, with a fixed seed in CI.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-14.1 | Time-splitting: `advance(advance(s, t1), t2)` equals `advance(s, t2)`. | `prop` |
| MUST-14.2 | Replay equals prediction: for the same accepted actions, the client's predicted state hash equals the server's. | `prop` |
| MUST-14.3 | Determinism: the same farm, actions and times give the same state hash. | `prop` |
| MUST-14.4 | No count of goods, no coins and no queue ever goes below zero or above its bound. | `prop` |
| MUST-14.5 | Goods are conserved, except where the rules create or consume them: production, orders, planting, gift send and claim. | `prop` |
| MUST-14.6 | A refused action leaves the farm unchanged. | `prop` |
| MUST-14.7 | Time never runs backwards: no action's time is below the farm's last action time. | `prop` |
| MUST-14.8 | Ties: generated farms include automated steps that finish at the same moment and compete for the last space in storage. Splitting `advance` exactly at that moment, or building the same farm in a different internal order, gives the same state hash (MUST-10.6). | `prop` |

### MUST-15 Protected acceptance tests

Agent PRs can't modify them.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-15.1 | A PR that changes `tests/acceptance/**` can't merge without the admin's approval. A CODEOWNERS entry and a ruleset on `main` requiring code-owner review enforce it. | `ci` |
| MUST-15.2 | A CI check fails any PR from an agent branch that touches `tests/acceptance/**`. | `ci` |
| MUST-15.3 | The acceptance tests run on every PR against a fresh stack, and they treat the app as a black box over HTTP. | `ci` |

The setup itself belongs to the M2 GitHub-strategy issue.

### MUST-16 Cheat-attack tests

Mapped to the threat model and the OWASP Top 10 (2025).

Each threat has at least one attack test, and each test fails if the attack succeeds. These tests
*prevent* cheating and don't depend on the store. *Detecting* cheating after the fact is
MUST-16.2.

| Threat | Attack | Expected result | OWASP 2025 |
| --- | --- | --- | --- |
| T1 | Forged or skewed client clock | Server time decides. Nothing ripens early. | A06 Insecure Design |
| T2 | Client sends a result or a quantity | Ignored or rejected. The server computes every outcome. | A08 Software or Data Integrity Failures |
| T3 | Replayed or duplicated request | The first answer comes back. Nothing applies twice. | A08 Software or Data Integrity Failures |
| T4 | Concurrent requests racing on one farm | No lost update, no double spend | A06 Insecure Design |
| T5 | Acting on or reading another player's farm | 403/404. Nothing changes. | A01 Broken Access Control |
| T6 | Claiming someone else's gift, or one gift twice | Refused | A01 Broken Access Control |
| T7 | Action spam | Over the per-farm rate limit → 429. Nothing committed. | A06 Insecure Design |
| T8 | Malformed or oversized input | 400/422, no 500, no partial write | A05 Injection, A10 Mishandling of Exceptional Conditions |
| T9 | Alt accounts funnelling goods by gifts | Capped by friends-only gifting, goods-only gifts and the daily limit | A06 Insecure Design |

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-16.1 | T1–T9 each have a passing attack test, and the table above is the report's threat model. | `attack` |
| MUST-16.2 | **Depends on ADR-0001.** Audits that rebuild a farm at a past time (`stateAt`) and check it, plus the attack tests that rely on them. | _after #12_ |

### MUST-17 CI and deployment

CI runs the checks on every PR. The game is deployed on Vercel with Supabase Postgres.

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-17.1 | Every PR runs typecheck, lint, unit and property tests, the determinism gate and the acceptance tests against a throwaway Supabase stack inside CI. A red check blocks the merge. | `ci` |
| MUST-17.2 | A merge to `main` deploys to Vercel production on the hosted Supabase project. | `ci` |
| MUST-17.3 | Each PR gets a Vercel preview that talks to a separate staging Supabase project. No preview touches production data. | `ci`, `review` |
| MUST-17.4 | Secrets come from environment variables. `.env.example` lists every name with a placeholder value. | `ci`, `review` |

## Must have: evaluation

### MUST-18 Two playtests

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-18.1 | **Playtest 1** (think-aloud, vertical slice): 5 participants, 20–30 min each, a task script and a short questionnaire (SUS or custom). | `playtest` |
| MUST-18.2 | **Playtest 2** (offline return): 5 participants play 15 min, stay away for at least 8 h and return. It measures whether they can tell what happened while they were away (MUST-07.3) and whether it felt fair. | `playtest` |
| MUST-18.3 | Participants are not on the project, and consent is recorded. Notes are anonymised. | `review` |

### MUST-19 System metrics

| # | Criterion | Verified by |
| --- | --- | --- |
| MUST-19.1 | **Latency**: p50 and p95 per route, from the `Server-Timing` measurements (load, sim, commit, total), as in the spike. | `metric` |
| MUST-19.2 | **Reconciliation rate**: reconciliations ÷ predicted actions, reported by the client in batches. | `metric` |
| MUST-19.3 | **Unlock curves**: time from farm creation to each Level and tier. They are written to a separate append-only metrics table when an action reaches the Level or tier. That table is telemetry, not farm history, so it doesn't depend on ADR-0001. | `metric` |

## Baseline qualities

These apply to every requirement above. _Open_: whether they get MoSCoW IDs of their own.

| # | Criterion | Verified by |
| --- | --- | --- |
| BASE-01 | The UI is in English. | `review` |
| BASE-02 | It works in the latest two versions of Chrome, Firefox and Safari, at desktop and phone widths (≥ 360 px). | `ui` |
| BASE-03 | The DOM UI meets WCAG 2.2 AA. | `ui`, `review` |
| BASE-04 | Action latency on the deployed stack has p95 < 300 ms. | `metric` |
| BASE-05 | A prediction shows within 100 ms of a tap (MUST-12.1). | `ui` |

## Should have

| ID | Criterion |
| --- | --- |
| SHOULD-01 | A player can view a friend's farm, read-only, as it is at server time. Viewing never writes, and only friends can visit (T5). |
| SHOULD-02 | Every Must crop, animal, good and facility has an asset instead of a placeholder. Every asset that ships is listed in `CREDITS.md` with its author, link and licence. No generative-AI art is used. |
| SHOULD-03 | Locust runs against the **deployed** stack at 200 players and keeps p95 within BASE-04. The results are analysed in `tools/analysis`. |
| SHOULD-04 | An anonymous player can link an email. Signing in with it in another browser opens the same farm. |
| SHOULD-05 | **Farmhands** on crops and animals:<br>• On crop duty, a farmhand harvests and replants (paying the seed price).<br>• On animal duty, a farmhand carries feed from the barn to the troughs and collects products from the pens into the barn.<br>• The player gives each farmhand a duty. It works by a fixed priority with fixed tie-breaks (lowest plot first), inside the simulation and with no randomness.<br>• Speed upgrades shorten a farmhand's working time. The **Foreman** upgrade lets farmhands choose their duty by a fixed priority across the farm.<br>• Farmhands are expensive and unlock late. Each further farmhand unlocks at a higher Level. |
| SHOULD-06 | **Clovers**: a few at every level-up, plus a small seeded chance on each delivered order. A player spends them to skip an order-board refill delay or to finish a job or crop now. They are never sold and never gifted. |

## Could have

| ID | Criterion |
| --- | --- |
| COULD-01 | Two friends can trade goods for goods, and each side's goods move only when both accept. |
| COULD-02 | Supabase Realtime pushes gift arrivals, and live changes during a visit, without a reload. |
| COULD-03 | Skill mini-games earn **clovers**. The server verifies each result by replaying the player's inputs against the seed. |
| COULD-04 | An event-store library replaces the hand-built action log, if ADR-0001 picks the log. The acceptance tests still pass unchanged. |
| COULD-05 | An admin dashboard shows the MUST-19 metrics and toggles feature flags (#1). |
| COULD-06 | **Tractor**: equipment that lets a farmhand on crops work a whole field as one task. |
| COULD-07 | Farmhands deliver orders, earning XP and coins and making room in storage while the player is away. |
| COULD-08 | **Production line** add-on: a facility repeats a sequence of recipes the player defines. It replaces Loop on that facility. |

## Won't have (this time)

WONT-01 to WONT-06 as in `moscow.md`, plus **WONT-07**: no play without a connection. Actions
aren't queued offline to be sent later. Queuing them would put predictions on top of predictions,
and stamp actions with times the server can't trust (MUST-11).

## Depends on ADR-0001

These need farm history and are settled after #12:

1. **MUST-07.5** An away summary "since you last looked", reaching back across actions.
2. **Farm activity history**: a timeline of past actions shown to the player. It isn't a MoSCoW
   item yet. _Open_: whether it becomes one.
3. **MUST-16.2** Detecting cheating after the fact: audits through `stateAt`, and the tests that
   use them.
4. **Support and debugging replay** of a reported bug. It isn't a MoSCoW item yet, and it is
   tooling for the admin.

The grill checked these and kept them **untagged**, because each works under either store:

- the away summary since the last action (MUST-07.3), which comes from advancing the stored farm;
- the gift history (MUST-08.7), which comes from the gift inbox, a table shared by both stores;
- the unlock curves (MUST-19.3), which come from a metrics table.

## Open questions

1. **ADR-0001 (#12)**: settles the four items above.
2. **A pen upgrade that collects**: farmhands on animal duty collect (SHOULD-05). The admin
   would also like a pen upgrade for this. Its shape and priority are still open.
3. **The browser-test tool** behind `ui` is a new dependency to approve.
4. **The rate limit for T7** (actions per farm per second), and whether it lives in config or in
   content.
5. **The OWASP 2025 mapping** in MUST-16: check it against the published list before the report
   cites it.
6. **Baseline IDs**: whether BASE-01–05 move into `moscow.md` as Musts.
7. **Where the state hash lives** (MUST-10.5): an M2 decision taken over from ADR-0001.
