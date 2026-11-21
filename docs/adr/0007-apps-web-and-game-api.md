---
status: proposed
---

# `apps/web` and the game API: layout, contract, auth, schema and tests

ADR-0001 chose store B100 and its loop (processed → load → advance → apply → commit → retry), and
ADR-0006 put a rules version on every log row and snapshot. Both left the app around them open:
ADR-0005 deferred `apps/web`'s layout to M3, and the spike (`prototype/persistence`, not merged) was
a plain Node server with its own SQL. M3 ("Actions persist end to end") builds the first game API,
so this ADR records how `apps/web` is laid out and which boundaries are enforced, the HTTP contract,
how a request becomes a player and a farm, the database schema and migrations, and how each level is
tested.

## How this was decided

The
[Wayfinder: M3 game API and persistence architecture](https://github.com/sssoto17/sunny-pastures/issues/324)
map, charted with the admin on 16 Nov 2026, split the question into three research tickets and six
decision tickets. Each decision was grilled with the admin, one question per turn, between 16 and 19
Nov, and each resolution comment was written to become one section here:

<!-- prettier-ignore -->
| Section | Ticket | Settled |
| --- | --- | --- |
| [1. Scope](#1-scope-what-m3-delivers) | [M3 scope: which spec criteria the first game API delivers](https://github.com/sssoto17/sunny-pastures/issues/325) | 16 Nov |
| [2. Layout](#2-layout-and-boundaries) | [apps/web module layout and boundaries](https://github.com/sssoto17/sunny-pastures/issues/329) | 17 Nov (Q1–Q6) |
| [3. Contract](#3-the-http-contract) | [Game API contract: routes, shapes, errors and idempotency](https://github.com/sssoto17/sunny-pastures/issues/330) | 17 Nov |
| [4. Auth](#4-auth-from-a-request-to-a-player) | [Auth seam: from a request to a player and a farm](https://github.com/sssoto17/sunny-pastures/issues/332) | 17–18 Nov (Q1–Q4) |
| [5. Schema](#5-schema-and-migrations) | [Schema and migrations for the B100 store](https://github.com/sssoto17/sunny-pastures/issues/331) | 17–18 Nov (Q1–Q11) |
| [6. Tests](#6-test-architecture) | [Test architecture for the game API](https://github.com/sssoto17/sunny-pastures/issues/333) | 18–19 Nov |

The research the grills started from:
[Research: Supabase anonymous sign-in verified in Next.js route handlers](https://github.com/sssoto17/sunny-pastures/issues/328)
(`getClaims` verifies locally, `getUser` makes a round trip; the admin role belongs in server-only
data; linking an email keeps the same id, so the player keeps their farm),
[Research: Postgres from Next.js on Vercel, driver, pooling and transactions](https://github.com/sssoto17/sunny-pastures/issues/326)
(Vercel reaches Supabase through Supavisor; a module-scope pool is reused under Fluid compute) and
[Research: what raises postgres.js UNSAFE_TRANSACTION inside sql.begin](https://github.com/sssoto17/sunny-pastures/issues/327)
(an upstream race in postgres.js 3.4.9, fixed by 4.x).

Q numbers restart in each grill, so a section's Q numbers are that ticket's. The contract and the
test architecture were settled as numbered decisions without Q numbers, and their sections follow
the resolution's own order. "Player", "farm", "action", "sequence number", "snapshot" and "rules
version" are used as `GLOSSARY.md` defines them; **Player** was added there for this ADR.

## 1. Scope: what M3 delivers

M3 is **API-only**. It is done when the acceptance and attack tests pass over HTTP against the local
stack; the first page is M4's.

- **In M3:** the B100 core (MUST-11.1–11.3, MUST-11.5, MUST-13.1–13.3, MUST-13.7); real Supabase
  anonymous sign-in, one farm per player keyed on the token's `sub` (MUST-09.4, attack-tested as
  T5); the attack tests T1–T5 and T8 in `tests/acceptance/`; a `rules_version` on every log row and
  snapshot, stamped `1`; `Server-Timing` on every game route (MUST-19.1); a reserved `429` in the
  error shapes.
- **The threat model** is the spec's T1–T10 table in MUST-16 (MUST-16.1). There is no separate
  document.
- **Later:** the display name (MUST-08.1), the unlock-curve metrics table (MUST-19.3) and
  reconciliation telemetry (MUST-19.2) (M4); the
  [Rules-version registry and the rules-version check](https://github.com/sssoto17/sunny-pastures/issues/154)
  (M4, before the first persistent deploy); gifts, the inbox and friends (MUST-08, MUST-11.4,
  MUST-13.4, MUST-13.5), the audit route and the admin role (MUST-16.2–16.5), the T7 rate limit and
  the attack tests T6, T7, T9 and T10 (M6); the OWASP 2025 mapping check (M8).

**Rejected:** a stub identity for M3 (throwaway work that leaves T5 unproven until M4); a minimal
page that sends an action (the prediction UI is M4's, and a page now would be rebuilt); a separate
threat-model document (the spec's table already is one).

## 2. Layout and boundaries

**Q1. Next.js and the top level.** `next@16.4.6`, pinned exactly, App Router under `src/`:

- `apps/web/src/app/` holds Next's files only (`page.tsx`, `layout.tsx`, `api/**/route.ts`). A
  `route.ts` is a thin adapter: it parses the request, calls one function from `server/api` and maps
  the result to a `Response`. It holds no logic.
- `apps/web/src/server/` holds server-only modules, each an ADR-0005 module (a folder, an
  `index.ts`, a `tests/` folder).
- `apps/web/src/client/` doesn't exist until M4 needs it.

**Q2, Q3. Seven server modules and a composition root.**

<!-- prettier-ignore -->
| Module | Interface (gist) |
| --- | --- |
| `config/` | `readConfig(env)`: typed config; a missing variable is a config error |
| `db/` | `createDb(config)`: the Drizzle client over postgres.js (section 5) |
| `rules/` | `createRules(content)` → `{ sim, newFarm, replay, rulesVersion }`. `replay` folds `apply` over the actions at their `at` (and throws on a refusal, ADR-0001), then `advance`s to `to`. M3 has one version (`rulesVersion = 1`); the M4 registry replaces the implementation behind the same interface |
| `store/` | the `GameStore` type and `createStore({ db, newFarm, replay })`: B100. The layout grill wrote `sql`; section 5, Q9 hands the store the Drizzle client instead |
| `auth/` | `createAuth(config)` → `{ readPlayer(request) }` (section 4) |
| `timing/` | `createTiming(clock?)` → `{ withTiming(phase, fn), renderServerTiming() }`: one recorder per request; phases `load`, `sim`, `commit`, `total`, summed across retries; the header value, or `null` when no phase ran (#394) |
| `http/` | the HTTP contract (section 3), added by #395: `readActionRequest` and `readFarmRequest` (the 415 → 413 → 400 checks and the action guards), `buildErrorResponse` and `buildJsonResponse` (the one error builder and the headers on every response). Builds `Response`s, so it isn't `game/` |
| `game/` | `submitAction(deps, playerId, body)` and `loadFarm(deps, playerId)`: ADR-0001's loop and the 422 re-check. Returns results, never `Response`s |
| `api/` | the composition root: `getApi()` builds config → db → rules → store → auth → deps, and exposes what the routes call |

Only `api/` wires modules together, and only a `route.ts` imports `api/`. `game/` sees `GameStore`
and `PlayerId` as types only, so it is tested against a fake store. There is no `inbox/` in M3
(gifts are M6).

**Q4. Enforcement.**

- `import "server-only"` is the first line of every `src/server/*/index.ts`. Next resolves it
  internally, so it is no new dependency, and a client import fails the build.
- Fallow boundary zones in `.fallowrc.jsonc`, run by `ci / boundaries`:

  <!-- prettier-ignore -->
  | From | May import | Type-only |
  | --- | --- | --- |
  | `routes` (`src/app/**/route.ts`) | `api` |  |
  | `pages` (the rest of `src/app/**`) | `sim` |  |
  | `api` | every server module, `sim` |  |
  | `game` | `rules`, `timing`, `sim` | `store`, `auth` |
  | `store` | nothing | `db`, `sim` |
  | `rules` | `sim` |  |
  | `auth` | `config` |  |
  | `db` | nothing | `config` |
  | `config`, `timing` | nothing |  |
  | `http` (#395) | `timing` | `sim` |

  `game` → type-only `auth` (for `PlayerId`) was added by the auth grill (section 4, Q4).
  `coverage.requireAllFiles` puts every file under `apps/web/src` in a zone. Section 6 adds a
  test-files-only allowance (`game/**/tests/**` → `store/tests/**`) and an `acceptance` zone with no
  allowances.

- Client code imports only the sim's package entry, which is the current content (ADR-0006, "The
  client"). The registry lives in `server/rules/`, out of the client's reach.
- `CONSTRAINTS.md`'s "Boundaries: server-only" row widens to these zones in the build ticket that
  adds them; there is no new row. The scaffold wrote the layout's zones into it; the auth module's
  ticket adds `game` → type-only `auth`, and the test tickets add their allowances.

**Q5. ADR-0005 in `apps/web`.** Cross-module imports go through `@/server/<module>` (the entry
only); inside a module they are relative and without `.js` (bundler resolution). Import sort groups
are packages, `@sunny-pastures/*`, `@/`, relative. `handleX` stays reserved for component handlers,
so server functions are verb-first (`submitAction`). Route files export Next's `GET` and `POST` (C6
already exempts `src/app/**`). `apps/web/tsconfig.json` extends `tsconfig.base.json` and is in the
root `references`. ADR-0005 is amended to point here.

**Q6. Runtime and lifetime.** Game routes set `export const runtime = "nodejs"` (postgres.js needs
TCP). `getApi()` builds the graph lazily and memoises it per process (Fluid compute reuses it), so
`next build` needs no `DATABASE_URL`. Tests build `deps` themselves and never call `getApi()`.

**Rejected:**

- **Pages Router:** legacy for new apps; Next 16 documents the App Router's route handlers.
- **A separate API server** (Hono or Fastify, like the spike's plain Node server): a second deploy
  target and toolchain, where Next route handlers keep one app on Vercel.
- **Server actions or tRPC for the game API:** the acceptance tests and Locust need plain HTTP with
  a stable contract.
- **A DI container (tsyringe, inversify) or a service locator:** classes are out of `apps/web`
  (ADR-0005), and a hand-written root is a dozen lines.
- **Module-scope (eager) construction:** `next build` imports route modules and would need a
  database URL.
- **`replay` in the sim:** the client never replays, and M4's version-aware replay spans several
  contents, which the sim can't own. **`replay` inside `game/`:** it mixes the loop with rules
  bookkeeping, and M4 would move it out again.
- **ESLint `no-restricted-imports` or dependency-cruiser for the zones:** Fallow already runs, is
  named in `CONSTRAINTS.md` for these rows, and supports type-only allowances.
- **Installing the `server-only` package:** Next resolves it internally.
- **Creating `client/` and `inbox/` now:** folders appear at the milestone that needs them.

## 3. The HTTP contract

### Routes

<!-- prettier-ignore -->
| Route | Does |
| --- | --- |
| `GET /api/farm` | Reads the caller's own farm. Never writes (MUST-11.5). |
| `POST /api/farm/actions` | Runs one action on the caller's own farm (ADR-0001's loop). |

No farm id travels in the path, the query or the body: the farm is the verified token's `sub`. A
player has one farm, and the farm's id is the player's id. Another player's farm can't be named, so
T5 holds by construction, and a request that tries (`?farm=`, a body `farmId`) is refused with 400
and reads or changes nothing. The spec's T5 row is updated to say so. M6's visit adds its own
read-only `GET /api/farms/:id` with a friend check.

There is no create-farm route: a farm with no accepted action loads as `newFarm` at `seq` 0, and its
first action writes its first row.

### Request

- **`Idempotency-Key` header**, a UUID the client makes with `crypto.randomUUID()`, following
  `draft-ietf-httpapi-idempotency-key-header`. A missing or non-UUID key gets 400. A reused key
  returns the first answer unchanged (MUST-13.2, ADR-0001). Unlike the draft, the body isn't
  compared: keys are scoped to one farm, and comparing would need a stored body hash for no gain a
  player sees.
- **Body** `{ action, expectedSeq }`. `expectedSeq` is a non-negative safe integer and only sets
  `answer.rebased`.
- **Hand-written guards**, one per sim action variant, each returning the sim's `Action`. A
  `Record<Action["type"], Parser>` fails the build when the sim adds a variant without a guard. The
  guards check shape only: a known `type`, the right fields and primitive types, safe non-negative
  integers, strings of at most 64 characters, and **no extra keys**. A request that sends a time, a
  result or a quantity is rejected with 400 (MUST-11.1, T1, T2). Meaning (does the crop exist, is
  the plot free) is the sim's, as a 422.
- **Checks before any database call,** in this order: a `Content-Type` other than `application/json`
  → 415; a body over **4 KiB** → 413 (from `Content-Length`, then by capping the bytes read, so a
  chunked body can't get past it); invalid JSON, a bad shape or a bad key → 400. `GET /api/farm`
  refuses any query parameter with 400. Authentication runs before all of them (section 4, Q4).
- **Where they live** (a note the contract grill left on
  [Build tickets for game API persistence from ADR-0007](https://github.com/sssoto17/sunny-pastures/issues/335)):
  `route.ts` stays a thin adapter (section 2, Q1), so the request guards, the error builder and the
  headers live in a server module the routes reach through `server/api`, where they are unit-tested.
  Which module holds them is the build ticket's call. #395 settled it (admin, 21 Nov 2026): a module
  of its own, `http/`, with its own zone that only `api` imports, so `api/` stays the composition
  root and the contract's imports are held by the boundary check.

### Response

Both routes return the same **farm envelope**, so the client has one reconcile path (MUST-12.2,
MUST-12.6):

```ts
type FarmEnvelope = { seq: number; at: number; state: FarmState; rulesVersion: number }; // not advanced past `at`

// GET /api/farm → 200
{
	farm: FarmEnvelope;
}

// POST /api/farm/actions → 200
{
	answer: Answer; // ADR-0001: { seq, hash, rebased, retries }, stored with the key, unchanged on a resend
	farm: FarmEnvelope;
} // first commit: the committed state; resend: a fresh load
```

- The stored `Answer` stays exactly as ADR-0001 defines it. The farm sits beside it, never inside
  it, so the idempotency record doesn't grow.
- **Neither route advances the farm to now.** The client runs the same sim and advances it locally,
  reads stay pure, and both routes return the same shape. This replaces the spike's GET, which
  advanced the farm.

### Errors

The body is `{ error: ErrorCode; message: string }`. `ErrorCode` is a closed union, exported for the
M4 client to switch on exhaustively. One builder makes every error, so no stack trace or SQL leaks.

<!-- prettier-ignore -->
| Status | `error` | When | Client |
| --- | --- | --- | --- |
| 400 | `bad_request` | bad JSON, bad shape, extra keys, a bad or missing key, a query on GET, another farm named | don't retry |
| 401 | `unauthorized` | a missing, expired or invalid token | refresh the session, then retry |
| 413 | `too_large` | a body over 4 KiB | don't retry |
| 415 | `unsupported_media_type` | not `application/json` | don't retry |
| 422 | `refused` | the sim (or, from M6, the inbox) refused; `message` is the sim's reason word for word, a sentence a player reads (ADR-0003 section 4, MUST-12.3) | undo the prediction, show `message` |
| 429 | `rate_limited` | reserved; the limit itself is T7, in M6 | retry after `Retry-After` |
| 503 | `busy` | still conflicting after 3 retries (MUST-13.3), and, per ADR-0006 (sections 5 and 8), a store error such as an unknown rules version | retry with the same key after `Retry-After: 1` |
| 500 | `internal` | a bug; a generic message | retry with the same key |

There are no 403 or 404 responses in M3: with no ids in the path, there is nothing to forbid and
nothing to not find.

### Headers on every game API response, errors included

- **`Server-Timing`** (MUST-19.1): POST sends `load`, `sim`, `commit` and `total`; GET sends `load`
  and `total`. Across retries each phase is summed (the count is in `answer.retries`). A phase that
  never ran is left out, not sent as 0. The timing Decorator builds it. The timings are public,
  which reveals nothing secret here.
- **`Rules-Version: <n>`** (ADR-0006, "The client"), so a client on old rules that gets a 422
  reloads instead of showing the refusal. The client sends no version: the server checks every
  action under its own rules.
- **`Cache-Control: no-store`.**

Requiring `application/json` means a cross-site form can't post without a CORS preflight, and the
API sends no CORS headers (same origin only). With a bearer token and no cookie (section 4, Q1),
there is no CSRF exposure.

The contract sets the attack-test cases for T1, T2, T3, T5 and T8; section 6 lists them with T4.

**Rejected:**

- **The key in the body**, as in the spike: non-standard, and the key is about delivery, not what
  the request means.
- **A schema library such as Zod or Valibot:** a new dependency and a second definition of `Action`
  to keep in step with the sim. Worth revisiting if M6's gift actions grow the guards a lot.
- **Returning only `Answer` plus `at`:** the client would recompute and compare hashes, and each
  stale `expectedSeq`, action in another tab or bonus-roll difference would cost a second round
  trip.

## 4. Auth: from a request to a player

Carried in: the player id is the farm id is the token's `sub`, with no mapping table, and
`newFarm(farmId)` seeds from that string (MUST-10.3); a farm's first row is written by its first
accepted action, so reads never write (MUST-11.5); M3 has no admin role.

**Q1. Bearer only.** The token travels as `Authorization: Bearer <access token>`. M4's browser
client takes it from its `supabase-js` session, which persists in that browser (MUST-09.2). There is
no cookie and no `@supabase/ssr`. A missing or malformed header → `401 unauthorized`. A cookie path
can be added inside `readPlayer` later, if M4 wants server-rendered pages, with no route change.

**Q2. `getClaims` plus our own claim checks.** `@supabase/supabase-js` (admin-approved, pinned
exactly, no install scripts) verifies the signature locally against the JWKS, which it caches per
process for 10 minutes. The local stack (CLI 2.122.0) signs with ES256, so verification is local
there too. `getClaims` checks only `exp` and the signature, so `readPlayer` also requires:

- `role === "authenticated"` and `aud === "authenticated"`;
- `iss === ${SUPABASE_URL}/auth/v1`;
- `sub` to be a UUID.

Anonymous and email-linked players are both accepted; `is_anonymous` isn't read. Every failure gives
the same 401, which never says which check failed. **Accepted trade-off:** a token stays valid until
it expires (`jwt_expiry`, 1 h), even after sign-out. M3 has no admin role and no sign-out route, and
a stale token reaches only its own farm.

**Q3. Test identity: real anonymous sign-ups.** Acceptance tests and Locust sign up against the
local stack (`POST /auth/v1/signup` with the publishable key) and get a fresh player, token and farm
each. Local `supabase/config.toml` turns on `enable_anonymous_sign_ins` and raises
`[auth.rate_limit] anonymous_users` (30 per hour per IP) for the local and CI stacks only. **There
is no test bypass in `readPlayer`.** Below HTTP, `game/` takes a `playerId` argument and needs no
token. T5's token cases are forged tokens: another key, `alg: none`, a wrong `iss`, a wrong `aud`,
an expired token.

**Q4. Interface and order.** `auth/` exports `createAuth(config)` → `{ readPlayer(request) }`, built
once by `getApi()`. `readPlayer` returns `{ ok: true, playerId: PlayerId } | { ok: false }` and
never throws on a bad token. `PlayerId` is a branded string, so only a verified id reaches `game/`
and the store. In each route, auth runs **first**, then the contract's 415 → 413 → 400 checks, then
`game/`. An unauthenticated caller learns nothing about validation, and since `getClaims` makes no
database call, "checks before any query" still holds. Fallow gains `game` → type-only `auth`.

**Rejected:**

- **The `@supabase/ssr` cookie, alone or beside bearer:** the CSRF question, middleware for cookie
  refresh and a second code path, which only server-rendered pages would need.
- **`getUser` on every request:** it sees sign-outs at once, but adds an Auth round trip to every
  request inside the response-time budget that
  [Spec: response-time criteria for M3 from the load matrix](https://github.com/sssoto17/sunny-pastures/issues/33)
  measures.
- **`jose` `jwtVerify` against the JWKS:** explicit `iss`, `aud` and algorithm checks, but a second
  auth dependency beside the supabase-js that M4's client needs anyway. The four claim checks cover
  the gap.
- **Minted test tokens (`supabase gen bearer-jwt`):** those identities don't exist in `auth.users`,
  which the schema references, and the tests would depend on key material.
- **A test-only bypass** (a header or a `NODE_ENV` switch): a backdoor that would have to be proven
  absent in production. Rejected outright.
- **Next middleware for auth:** it runs on every route, can't reach `getApi()`'s graph, and hides
  the check from the route. **A `withPlayer(handler)` wrapper:** an extra layer over a thin adapter,
  for two routes.

## 5. Schema and migrations

Drizzle was already part of M3's planned stack, so it isn't recorded here as a choice. Drizzle facts
were checked against the npm registry and the published sources; the items marked _to confirm_ are
acceptance checks in the build tickets.

**Q1. An unexposed schema.** Every game table lives in a Postgres schema `game` (Drizzle
`pgSchema("game")`). It isn't in `[api].schemas` in `supabase/config.toml`, so PostgREST doesn't
expose it. Only the server reaches it, over `DATABASE_URL`.

**Q2, Q2b. Least privilege.**

- `revoke all` on schema `game` and its tables from `anon`, `authenticated` and `public`.
- Row-level security is on for every table with **no policies** (`.enableRLS()`), so even a later
  exposure reads nothing.
- The app connects as a **`game_api` login role** with `usage` on `game` and only `select` and
  `insert` on `actions` and `snapshots`. With no `update` or `delete`, the log is append-only by
  grant, not by convention (ADR-0001, T10).
- **`game_api` has `BYPASSRLS`** (admin, 19 Nov 2026, #372). RLS with no policies refuses every row
  to a role that doesn't bypass it, `game_api` included, so without it the app could read and write
  nothing. The pattern: a least-privilege role limited by its grants, with RLS as deny-all for the
  API roles (`anon`, `authenticated`). Alternative considered: policies `to game_api` on both
  tables, without `BYPASSRLS`. Rejected: they would allow every row, since the app checks the farm
  owner in code (section 4), so they add SQL without adding protection.
- Migrations run as `postgres`, which owns the tables, so `on delete cascade` from `auth.users`
  works.
- The migration creates the role with `LOGIN` and **no password**. `pnpm db:env` generates a random
  password, sets it against the local stack without printing it, and writes `game_api`'s
  `DATABASE_URL` to `.env`; `.env.example` keeps a placeholder, and CI runs the same script after
  `supabase db reset`. Hosted roles stay with
  [Decide how migrations reach hosted Supabase (staging and production)](https://github.com/sssoto17/sunny-pastures/issues/64).

**Q3. No farms table.** `farm_id` is a `uuid` referencing `auth.users(id)` with `on delete cascade`,
through `authUsers` from `drizzle-orm/supabase`, so drizzle-kit doesn't manage `auth`. A farm with
no actions has no row and loads as `newFarm` at seq 0. M4's display name adds a players table when
it needs one.

**Q4, Q4b. Columns.** Every column is `not null`.

<!-- prettier-ignore -->
| Table | Columns |
| --- | --- |
| `game.actions` | `farm_id uuid` → `auth.users`; `seq bigint check (seq between 1 and 9007199254740991)`; `at bigint check (at between 0 and 9007199254740991)` (server time, ms); `action jsonb`; `idempotency_key uuid`; `answer jsonb`; `rules_version integer check (rules_version > 0)` |
| `game.snapshots` | `farm_id uuid` → `auth.users`; `seq` and `at` with the same checks; `state jsonb`; `rules_version integer check (rules_version > 0)` |

- `seq` and `at` use `bigint({ mode: "number" })`. Drizzle converts with `Number()`, which silently
  loses precision above 2^53, so the check constraints refuse such a value on write. That replaces
  the spike's `checked()` safe-integer guard.
- `jsonb` is safe for the state: `stateHash` hashes canonical JSON (sorted keys), and the state
  holds safe integers only. `.$type<T>()` gives the type without a runtime check.
- `rules_version` has **no default**, so a write that forgets to stamp it fails.
- No `created_at`: `at` is server time.

**Q5. Keys only, no secondary indexes.** `actions`: primary key `(farm_id, seq)` (serves `load`) and
`unique (farm_id, idempotency_key)` (serves `processed` and catches a duplicate on insert).
`snapshots`: primary key `(farm_id, seq, rules_version)`; `load` reads
`order by seq desc, rules_version desc limit 1`, so at the same seq the higher version wins
(ADR-0006 section 5).

**Q6. Gap-free sequence numbers.** The spike's conditional insert
(`insert … select … where expectedSeq = 0 or exists (row at expectedSeq) on conflict do nothing returning`)
is the only guard. There is no `prev_seq` self-reference. MUST-13.1 and T4 test it from outside.

**Q7. Migrations.**

- The tables are TypeScript (`server/store/schema.ts`). `drizzle-kit generate` with
  `migrations.prefix: "supabase"` writes `YYYYMMDDHHMMSS_<name>.sql` to `supabase/migrations`, and
  `supabase db reset` applies the same files locally and in CI: one folder, one applier.
- What drizzle-kit can't express (the role's `LOGIN`, every `GRANT` and `REVOKE`) goes in a
  `drizzle-kit generate --custom` migration.
- **Forward-only:** an applied migration is never edited; a fix is a new migration. This becomes a
  `CONSTRAINTS.md` row.
- CI runs `drizzle-kit check` and a drift check that fails when `drizzle-kit generate` would write a
  new migration (`check` alone validates only drizzle-kit's own snapshot and journal).
- _To confirm:_ `supabase db reset` ignores drizzle-kit's `meta/` folder beside the SQL. If it
  doesn't, drizzle-kit writes to `apps/web/drizzle/` and a script copies only the `.sql` files.
- drizzle-kit stays on 0.x: the 1.0 release candidate writes one folder per migration, which the
  Supabase CLI doesn't read.

**Q8. No seed rows.** Tests set up their own players and farms. An empty `supabase/seed.sql` with a
comment makes `[db.seed]`'s path real.

**Q9. Where the tables live, and what carries over from the spike.**

- The store owns its tables (`server/store/schema.ts`), and `drizzle.config.json` points there
  (JSON, not `.ts`: drizzle-kit reads a default export, which ADR-0005 C6 bans outside `src/app/`;
  admin, 19 Nov 2026, #372).
- `server/db/` builds the Drizzle client over postgres.js. The store receives it as an argument and
  imports only its type, so `store` → type-only `db` holds.
- No DDL at runtime: the spike's `create table if not exists` moves into the migrations.
- Reads (`load`, `processed`, the latest snapshot) use the query builder. The commit runs in
  `db.transaction` (postgres.js `sql.begin`), and its conditional insert stays a raw `sql` template,
  because postgres.js 4.x lets the server infer parameter types.
- Carried over: the spike's queries, with `uuid` ids and `rules_version` on every row and every
  100th-action snapshot. Dropped: the `schema` parameter, the B1/B25 branches and the `inbox`
  option. M6 adds an inbox write inside `commit`'s transaction, with its own migration, so the room
  left for it is the transaction, not a table.
- Base snapshots (ADR-0006 section 3) are never written in M3, which has one version, but reads
  already apply the tie-break.

**Q11. Dependencies** (approved by the admin, 18 Nov; the resolution records no separate Q10):
`drizzle-orm@0.45.4`, `drizzle-kit@0.31.11` (dev) and `postgres@4.1.1`, the 4.x upgrade that fixes
the `UNSAFE_TRANSACTION` race. esbuild's `postinstall` (pulled in by drizzle-kit) stays disallowed.
_To confirm:_ `drizzle-kit generate` runs without it, and Drizzle works on postgres.js 4.x (untested
anywhere); the first store test against the local stack proves it. If it fails, the fallback
(postgres.js 3.4.x plus a workaround for the race) is decided with the admin then.

**Rejected:**

- **Tables in `public`:** PostgREST exposes them, so one misconfigured policy opens the log.
- **Connecting as `postgres`, append-only by review:** then append-only is a convention, not a
  check.
- **A `game.farms` table:** a second write on the first commit, with nothing in it.
- **`json` instead of `jsonb`:** it keeps key order, which the canonical hash doesn't need, and
  gives up querying the state.
- **`bigint({ mode: "bigint" })`:** `BigInt` would spread through `game/` while the sim uses
  numbers.
- **Secondary indexes, or a `prev_seq` self-reference:** extra writes on the measured hot path for
  guarantees the key and the conditional insert already give.
- **Supabase declarative schemas (`supabase db diff`):** a second schema tool beside Drizzle.
  **Drizzle 1.0 rc:** not stable, and its per-folder layout doesn't fit the Supabase CLI.
- **The tables in `db/`, with the zone widened:** it puts the store's tables under the module that
  only builds the connection.
- **The conditional insert in Drizzle's builder:** under postgres.js 4.x's server-side parameter
  typing it needs casts, so the raw template is the safer port.
- **The password in a migration** (a committed secret), **or seed rows** (fake `auth.users` rows,
  and tests coupled to each other).

## 6. Test architecture

### Levels, and where each runs

<!-- prettier-ignore -->
| Level | Where | Runner | Needs | Counts for coverage | Check |
| --- | --- | --- | --- | --- | --- |
| `unit` | `{apps,packages}/*/src/**/tests/` | root Vitest, project `unit` | nothing | yes | `ci / test` |
| `db` | `*.db.test.ts` in `apps/web/src/server/**/tests/` | root Vitest, project `db` | the local Supabase stack | yes | `ci / test` |
| acceptance and attack | `tests/acceptance/**` (admin-owned) | its own Vitest config | the built app and a stack, over HTTP | no | `ci / acceptance` |
| load and concurrency | `tools/load/` (Python, uv) | Locust on a cloud load VM | `next start` and the local stack | no | none: a milestone run |

### The `db` project

- The root `vitest.config.mts` splits into two **projects**, `unit` and `db`, run together in
  **one** coverage run, so `coverage-gate.mjs` reads one lcov and doesn't change. Store code can
  only be reached with a database, so leaving `db` out of coverage would fail the 80% floor by
  construction.
- `ci / test` starts a stack (`supabase start`, `supabase db reset`, `pnpm db:env`) **only when the
  PR touches `apps/web/src/server/**` or `supabase/**`**. Otherwise it runs `--project unit`, and
  the gate runs `--skip-ratchet`, because untested store files would read 0% (as `check:task`
  already does for partial runs).
- **The ratchet runs in full on `main`** (admin, 19 Nov, an addendum to the test-architecture
  resolution). Every push to `main` always starts the stack and runs both projects with the full
  gate, ratchet included. A drop that merges through a PR without the stack turns `main` red on that
  merge, so nothing drifts unseen. PRs that touch `apps/web/src/server/**` or `supabase/**` still
  check the ratchet before merging, and the changed-line floors (90%/80%) apply to every PR as
  before.
- **No conditional skips.** A `db` test without a stack **fails** with "run `pnpm db:start`"; it
  never `skipIf`s, because a runtime skip is a silent pass the floor guard can't see. The only
  switch is the project selection in `ci.yml`, from the changed paths, where a reviewer sees it.
- **Isolation by farm.** Each `db` test makes its own player by inserting an `auth.users` row
  through a test-only admin connection (the local stack's own env, never printed). The store under
  test still connects as `game_api`. Nothing is truncated, files run in parallel, and the stack
  resets once per CI run. Real anonymous sign-ups belong to the auth module's tests and the
  acceptance tests.

### The store gate

`ci / determinism` keeps step 0 (the sim in two processes, no stack). One `db` test in
`server/store/tests/` adds the store half of ADR-0001's gate: it plays the recorded
`determinismScript.json` through `createStore` on the local stack, committing accepted actions and
still offering refused ones. At every snapshot seq, after the 8-hour gap and at the end, `load()`
must strictly deep-equal the in-memory farm (types included), and the final state hash must equal
`determinismScript.hash`. It reads both files and never writes them. If `ci / determinism` is green
and this test is red, the store is at fault, which keeps ADR-0001's "where does the failure lie"
property. The `stateAt` checks at random times move to M6 with the audit route.

### Action-handler tests: an in-memory store held to a contract

- `createMemoryStore()` in `server/store/tests/memoryStore.ts` implements `GameStore`, with an
  optional script of injected conflicts ("conflict twice, then commit"). `game/`'s retry loop, the
  `busy` path, `rebased`, a resend and the 422 mapping are tested with no database and no timing.
- **One contract suite,** `server/store/tests/contract.ts`, exports `describeGameStore(makeStore)`:
  gap-free seqs, a resent key returns the first answer, a stale `expectedSeq` conflicts, the
  snapshot at 100 is used, and load equals replay. It runs against the fake (`unit`) and against
  B100 (`db`).
- `game/` tests import the fake through one Fallow allowance for **test files only**
  (`game/**/tests/**` → `store/tests/**`), as ADR-0005 section 4 allows for a helper owned by
  another module's `tests/`. Production `game` code still reaches `store` only for types.

### Acceptance tests

- **Who writes them:** a lane drafts them and **pushes as the admin**, on a run the admin starts
  deliberately; the admin reviews and merges. Lanes default to `sunny-factory[bot]`, so this needs a
  lane option, off by default, that keeps the admin's identity. The guarantee is: _the factory can't
  change acceptance tests, and every change to them was started by the admin._ It rests on which
  identity runs, not on the content, and that limit is stated here on purpose.
- **MUST-15.2's detector is the PR author.** A required `guard / acceptance` fails when a
  `[bot]`-authored PR touches `tests/acceptance/**`. The App's token sets the author, so an agent
  can't fake it. The check runs the default branch's copy, as `guard / floor` does. The spec's
  MUST-15.2 is reworded from "an agent branch" to the PR's author.
- **Harness:** its own `tests/acceptance/vitest.config.mts`, outside the root projects and with no
  coverage. The target comes from env (`ACCEPTANCE_BASE_URL`, the Supabase URL and publishable key),
  so the same suite can point at a Vercel preview in M4. The app runs as `next build && next start`,
  never `next dev`. Each test signs up its own anonymous player over Auth HTTP. There are **no
  imports from `apps/` or `packages/`** (a Fallow zone `acceptance` with no allowances), and
  expected values are written out literally, so a refactor can't reshape the contract.
  `pnpm test:acceptance` builds, starts, waits on `/api/health`, runs and stops.

### Attack tests

Over HTTP in `tests/acceptance/attack/`, one file per threat, admin-owned and drafted the same way.
They are MUST-16.1's evidence for M3. Agent-owned unit tests (the guards, `readPlayer`) still sit
underneath them but don't count as the evidence.

<!-- prettier-ignore -->
| Threat | Attack | Pass |
| --- | --- | --- |
| T1 | plant, then harvest at once with a forged `Date` header; send `at` in the body | 422 not ripe; 400 extra key |
| T2 | send a quantity or a result | 400; the farm is unchanged |
| T3 | resend the same `Idempotency-Key` | the identical answer; `seq` advanced once |
| T4 | 20 concurrent harvests of one ripe plot, each with its own key | exactly one lands; the rest get 422 or 503; `seq` is gap-free |
| T5 | A's token with `?farm=B` or a body `farmId` | 400; B's farm is byte-identical |
| T8 | bad JSON, extra keys, a 5 KiB body, a wrong content type, a chunked oversize body | 400, 413 or 415, never 500, no write |

T6, T7, T9 and T10 come with M6.

### Load and concurrency

One **milestone run on a cloud load VM, never in CI**: shared runners make timings noise, and
Actions minutes are tight.

- `tools/load/` is a uv project ported from the spike's (Locust pinned, `exclude-newer` 7 days
  back). It runs against `next start` and the local stack with ADR-0001's method: 50 and 200
  players, the stress run (200 players, no wait, 2 min measured) and the per-phase `Server-Timing`
  split.
- Players sign up anonymously. The API has **no clock header** (one would be a T1 hole), so the
  8-hour returners are seeded by backdating their last action through the admin connection before
  the run.
- **M3's stand-in for MUST-13.5:** the spike's concurrency script with 1,000 harvest-and-harvest
  pairs at one farm, and no lost update (seqs rebuilt from the log). The gift-and-harvest version is
  still MUST-13.5 itself, in M6.
- Results go in `docs/load/m3/`. They feed
  [Spec: response-time criteria for M3 from the load matrix](https://github.com/sssoto17/sunny-pastures/issues/33)
  and close the stress criterion of
  [Check transaction use under load: postgres.js UNSAFE_TRANSACTION in the B100 stress run](https://github.com/sssoto17/sunny-pastures/issues/28).

### `CONSTRAINTS.md` (tightenings only)

- The acceptance row adds "including `tests/acceptance/attack/`: T1–T5 and T8 each have a passing
  attack test (MUST-16.1; the rest in M6)".
- A new row: no `[bot]`-authored PR touches `tests/acceptance/**`, under the required
  `guard / acceptance`.
- The M3 watch: `check:task`'s 90 s is measured once the store tests land. If it's over, the
  pre-approved first lever applies (only related tests run), and anything beyond that goes to the
  admin.

**Rejected:**

- **A separate `ci / integration` job with its own lcov:** a second stack and a merged-lcov gate.
- **A nightly full-gate run instead of every push to `main`:** cheaper, but a drop is found up to a
  day later and is mixed across merges. **The stack on every PR:** no loosening at all, but 1–2 more
  runner minutes on every PR.
- **Store behaviour tested only through acceptance tests:** store code would fail the coverage floor
  by construction.
- **Real Auth sign-ups in `db` tests:** couples store tests to Auth and its rate limit. **Truncating
  between tests:** serial and slower, and it hides concurrency bugs.
- **The store gate inside `determinism-gate.mjs`:** it puts a stack in `ci / determinism` and gives
  a code-owned runner I/O.
- **Per-test stubs, or handler tests on the real store:** stubs with no contract can lie, and real
  conflicts depend on timing.
- **Agent PRs with `review:admin` for acceptance tests:** breaks MUST-15.2. **The admin writes them
  from scratch:** the cost in a deadline week. **Detecting agents by commit trailer or branch:**
  easy to break, and it catches the admin's own commissioned runs.
- **Acceptance tests importing the sim's types and content:** the contract would move with the code.
  **Playwright API testing:** a new dependency, and the browser-test tool's own decision.
- **Attack tests as agent-owned `unit` or `db` tests:** the agent writing the defence would write
  its proof.
- **A Locust smoke on every PR:** noise on shared runners, and it costs minutes. **No load run in
  M3:** the load-matrix criteria and the transaction check would slip.

## Patterns

<!-- prettier-ignore -->
| Pattern | Where | Why | Alternatives considered |
| --- | --- | --- | --- |
| Composition Root, dependency injection by argument | `server/api` (`getApi()`), the `deps` parameter | One place knows the whole graph; tests swap collaborators as values | a DI container, a service locator |
| Lazy initialisation, memoised | `getApi()` | Built once per process, never at build time | eager construction at module scope |
| Humble Object (thin adapter) | `route.ts` | Framework code that is hard to test holds no logic | Next middleware, a `withPlayer` wrapper |
| Functional core, imperative shell (ADR-0001) | `game/` with the sim | `game/` returns results; the routes and the store do the I/O | — |
| Facade with a Strategy slot | `rules/` | One interface over content → sim, `newFarm`, `replay`; M4's registry swaps the implementation | `replay` in the sim, `replay` in `game/` |
| Decorator | `timing/` (`createTiming(clock?)` → `{ withTiming(phase, fn), renderServerTiming() }`) | Times a step without editing it | — |
| Layered architecture, enforced | Fallow zones, `server-only` | The direction of dependencies is checked, not reviewed | ESLint `no-restricted-imports`, dependency-cruiser |
| Resource scoped to the caller ("me" resource) | `/api/farm` | Ownership comes from identity, so there is no ownership check to forget (T5) | — |
| Idempotent Receiver | `Idempotency-Key`, `unique (farm_id, idempotency_key)` and the stored `answer` | A retry gets the first answer, stored in the row that claims the seq | the key in the body (the spike) |
| Parse, don't validate | the request guards in `http/` return the sim's `Action`; the branded `PlayerId` | Handlers only see checked values, and a raw string can't stand in for a verified id | a schema library (Zod, Valibot) |
| Table-driven dispatch, checked for exhaustiveness | `http/`'s guards: one per variant, keyed by `Action["type"]`, built from a field table | The build fails when the sim adds a variant without a guard; each guard is one line | a `switch` over `type` (exhaustive too, but each case hand-written), a schema library |
| Factory with a closed message catalogue | `http/`'s `buildErrorResponse` | One function makes every error body and its headers; only the sim's refusal reason is free text, so no stack trace or SQL can reach a body | each route building its own `Response`, Next middleware |
| Envelope | `{ answer, farm }` | The stored answer stays small; the farm is a fresh read | the farm inside the answer, the answer alone |
| Version negotiation by tag (ADR-0006) | `Rules-Version`, `farm.rulesVersion` | The client reloads on a mismatch | — |
| Bearer token (RFC 6750) | `Authorization` header | Stateless, no CSRF, the same for the browser, tests and Locust | the `@supabase/ssr` cookie |
| Result type instead of exceptions | `readPlayer` | A bad token is an expected outcome; the route maps it to 401 | — |
| Cache-aside (inside supabase-js) | the JWKS behind `getClaims` | Local verification at near-zero cost per request | `getUser` per request |
| Event Sourcing with Snapshots (ADR-0001, ADR-0006) | `game.actions`, `game.snapshots` | The log is the truth; snapshots are a cache keyed by version | — (ADR-0001) |
| Optimistic Offline Lock | the conditional insert | The row for `expectedSeq + 1` is written once, and only after its predecessor | a `prev_seq` self-reference |
| Repository | `store/` owns `schema.ts` behind `GameStore` | SQL stays behind one interface | the tables in `db/` |
| Least privilege, defence in depth: a least-privilege role limited by grants, RLS as deny-all for the API roles | `game_api` grants (and `BYPASSRLS`), RLS with no policies, an unexposed schema | Append-only is enforced by the database; three layers keep PostgREST out | tables in `public`, connecting as `postgres`, policies `to game_api` (they'd allow every row) |
| Schema as code, generated forward-only migrations | Drizzle → drizzle-kit → `supabase/migrations` | One typed definition, a reviewable SQL history and a drift check between them | Supabase declarative schemas, Drizzle 1.0 rc |
| Test pyramid by I/O boundary | `unit`, `db`, acceptance, load | Each level runs only where its dependency exists | a separate integration job, acceptance-only store tests |
| Contract test | `describeGameStore` over the fake and B100 | The fake can't drift from the store without failing the same suite | per-test stubs |
| Fake object (in-memory repository) | `createMemoryStore` | Retries and conflicts become deterministic | handler tests on the real store |
| Data isolation by key | a fresh player per test | Parallel tests share one stack without truncation or rollback | truncating between tests |
| Golden master | the store gate against `determinismScript.hash` | The recorded hash pins the rules; the store must reproduce it | the gate inside `determinism-gate.mjs` |
| Black-box contract test, protected test oracle | `tests/acceptance/**`, `guard / acceptance` | The tests can't move with the code, and the agent that writes the defence doesn't write its proof | agent-owned attack tests, imports from `apps/` |

## Consequences

- **Build work is filed under
  [Game API persistence](https://github.com/sssoto17/sunny-pastures/issues/74).** Each decision
  ticket filed its own build tickets as it resolved, and
  [Build tickets for game API persistence from ADR-0007](https://github.com/sssoto17/sunny-pastures/issues/335)
  files the rest. Every ticket that creates `store/`, `rules/` or `game/` in `apps/web/src/server/`
  is natively blocked by
  [CI: sim boundaries, benchmark budget and mutation score](https://github.com/sssoto17/sunny-pastures/issues/41),
  so the zones run in CI before those layers exist (admin, 17 Nov).
- **ADR-0005 is amended** where `apps/web` extends it: the web layout, import groups, `handleX` and
  the `*.db.test.ts` name point to sections 2 and 6.
- **ADR-0002 is amended:** its `guard / protected-paths` (MUST-15.2) is built as
  `guard / acceptance` and reads the PR's author, not agent trailers (section 6). **ADR-0006 is
  amended** to point to the timetable change below.
- **The spec changes in four rows:** T2 (rejected with 400, not "ignored"), T5 (another farm can't
  be named; a try is a 400), T8 (adds 413 and 415) and MUST-15.2 (the detector is the PR's author,
  not its branch).
- **`CONSTRAINTS.md` gains rows in the build tickets,** each a tightening: forward-only migrations
  (section 5, Q7), `guard / acceptance` and the attack tests in the acceptance row (section 6). The
  "Security-sensitive code" row says its paths become globs once `apps/web/src/server/` exists;
  sections 2 and 3 fix those paths (`auth/`, the request guards, `game/`, the store's commit).
- **Open, for the admin:** no grill placed the types the M4 client needs (`FarmEnvelope`,
  `ErrorCode`). The `pages` zone imports only the sim, so where these types live is M4's decision,
  with the client.
- **ADR-0006's timetable moves.** ADR-0006 expected the registry and the rules-version check before
  the first release in M3; section 1 moves them to M4, before the first persistent deploy. M3 writes
  `rules_version = 1` everywhere and never crosses a version, and `rules/` is the slot the registry
  fills.
- **Accepted trade-off: a token stays valid until it expires** (section 4, Q2), up to an hour after
  sign-out.
- **Accepted trade-off: a PR without the stack skips the coverage ratchet** (section 6). Every push
  to `main` runs the full gate, so a drop turns `main` red on the merge that caused it.
  [Vitest db project and a Supabase stack in ci / test](https://github.com/sssoto17/sunny-pastures/issues/382)
  builds both.
- **Accepted trade-off: the acceptance tests' protection rests on identity.** A lane that pushes as
  the admin is the admin's act; `guard / acceptance` can't tell what such a run wrote.
- **Accepted trade-off: some checks are confirmed only when built** (section 5): `supabase db reset`
  beside drizzle-kit's `meta/`, drizzle-kit without esbuild's `postinstall`, and Drizzle on
  postgres.js 4.x. Each is an acceptance check whose failure goes back to the admin.
- **Accepted trade-off: the farm isn't advanced on reads.** The client advances it locally, which
  the M4 client has to do from the first page.
