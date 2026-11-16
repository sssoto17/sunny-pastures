# Research: Postgres from Next.js on Vercel (driver, pooling, transactions)

Research for [Research: Postgres from Next.js on Vercel, driver, pooling and transactions](https://github.com/sssoto17/sunny-pastures/issues/326),
under [Wayfinder: M3 game API and persistence architecture](https://github.com/sssoto17/sunny-pastures/issues/324).
Facts and trade-offs only; the decision belongs to the schema and layout tickets. Throwaway branch,
never merged. Sources read on 16 Nov 2026.

## Summary

- **postgres.js direct** carries ADR-0001's commit as-is (`sql.begin` with the conditional insert
  and `on conflict do nothing`). On Supabase's **transaction-mode** pooler (port 6543) it needs
  `prepare: false`; `sql.begin` still works there, because a transaction-mode pooler keeps one
  server connection for the length of a transaction.
- **supabase-js / PostgREST RPC** can also carry the commit: PostgREST runs each request in one
  transaction and a `RAISE` rolls it back. The commit logic then moves into a PL/pgSQL function, and
  the store's TypeScript (and its tests) becomes a thin HTTP call.
- **Vercel is IPv4-only outbound** per Supabase, and Supabase's direct connection is IPv6 unless
  the paid IPv4 add-on is bought. So from Vercel the realistic routes are the shared Supavisor
  pooler (session 5432 or transaction 6543) or HTTP (PostgREST).
- **Fluid compute** (default for new Vercel projects since 23 Apr 2025) shares one instance and its
  module-scope pool across concurrent requests. Vercel's `attachDatabasePool` does not recognise a
  postgres.js `sql` object (it duck-types `pg`, mysql2, MariaDB, MongoDB, ioredis, Cassandra);
  with postgres.js the lever is a short `idle_timeout`.
- **Limits:** Free (Nano) and the smallest Pro compute (Micro) both allow 60 database connections
  and 200 pooler clients.
- **Local and CI:** the local stack is Postgres 17 like hosted, but with the pooler off
  (`[db.pooler] enabled = false`). Locally the pooler is Supavisor 2.9.13 (CLI 2.122.0). Turning it
  on in transaction mode is the way to test the production connection path. CI runs no database
  today.
- **bigint:** postgres.js returns `int8` as a string by default. The spike's custom `types.bigint`
  parser (`Number(x)`) is a convenience, and ADR-0001's `Number.isSafeInteger` check at the store
  boundary stays the guard.

## 1. The options

### postgres.js direct (what the spike used)

- The spike (`origin/prototype/persistence`, `prototypes/persistence/package.json`) pins
  `postgres` 3.4.9. Both stores commit inside `sql.begin(async (tx) => …)`
  (`src/store-a.ts`, `src/store-b.ts`). B's commit is one conditional insert of the next `seq`
  (`where expectedSeq = 0 or exists (… seq = expectedSeq) on conflict do nothing returning 1`),
  then the inbox write, then the snapshot. An empty `returning` means a conflict or a duplicate key.
- "Use `sql.begin` to start a new transaction. Postgres.js will reserve a connection for the
  transaction and supply a scoped `sql` instance … `BEGIN` is automatically sent … and if anything
  fails `ROLLBACK` will be called"
  ([README, Transactions](https://github.com/porsager/postgres/blob/master/README.md#transactions)).
  Savepoints via `sql.savepoint` inside the scope.
- In source (3.4.9, `src/index.js` `begin`): `BEGIN` is sent through `sql.unsafe(...)` with an
  `onexecute` hook that marks the connection reserved; the callback runs; then `commit`, or
  `rollback` on a throw.
- So postgres.js supports the multi-statement transaction with the optimistic `seq` check, and the
  spike measured it (ADR-0001, `docs/adr/0001-persistence-model.md`).

### supabase-js / PostgREST, with an RPC function

- PostgREST: "every request to an API resource runs inside a transaction"; "You can also RAISE an
  error inside a function to cause a rollback"; default isolation is READ COMMITTED; a POST to a
  VOLATILE function runs READ WRITE
  ([PostgREST, Transactions](https://docs.postgrest.org/en/stable/references/transactions.html)).
- So an RPC function (`supabase.rpc('commit_action', …)`) can carry the whole commit: the
  conditional insert, the inbox write, the snapshot, and a `RAISE` (or a returned status) for
  conflict/refused. One HTTP round trip per commit, no TCP Postgres connection from Vercel.
- Vercel's pooling guide lists HTTP database APIs ("Supabase's PostgREST") as an alternative that
  needs no persistent connection
  ([Vercel KB, Connection pooling with Vercel Functions](https://vercel.com/kb/guide/connection-pooling-with-functions)).
- Trade-offs (my reading, not from a source): the commit logic lives in SQL/PL-pgSQL in a
  migration, not in TypeScript beside the store interface; reads (`load`, `stateAt`) would also go
  through PostgREST or more RPCs; access goes through PostgREST roles and RLS, or the service-role
  key on the server; the store tests from the spike (postgres.js, direct) would not exercise the
  same path. The spike never measured PostgREST latency.

### Other drivers

- `pg` (node-postgres) is the driver Vercel's `attachDatabasePool` example and type definitions
  are written for (`PgPool` with `options.idleTimeoutMillis` and a `release` event;
  [`@vercel/functions` reference](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#attachdatabasepool),
  `@vercel/functions@3.11.3` `db-connections/index.d.ts`). It also supports transactions
  (`BEGIN`/`COMMIT` on one checked-out client). Not measured in the spike; switching means
  rewriting the stores' query layer.

## 2. Supavisor: session vs transaction mode

From [Supabase, Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres):

| Route | Host:port | IP | Notes |
| --- | --- | --- | --- |
| Direct | `db.<ref>.supabase.co:5432` | IPv6, IPv4 only with the paid add-on | "for persistent backends such as VMs and long-running containers" |
| Shared pooler, session mode | pooler host `:5432` | IPv4 on all plans | Alternative to direct on IPv4-only networks; one server connection per client for the whole session |
| Shared pooler, transaction mode | pooler host `:6543` | IPv4 on all plans | Recommended "for serverless and edge functions, which open many short-lived connections" |
| Dedicated pooler (PgBouncer) | `:6543` | IPv6, or IPv4 add-on | Pro and above; transaction mode only; supports prepared statements on PgBouncer 1.21+ |

What transaction mode breaks (same page):

- **Prepared statements:** "The shared pooler doesn't support prepared statements in transaction
  mode." postgres.js prepares statements by default (`prepare: true`); turn it off with
  `postgres(url, { prepare: false })`
  ([README, Prepared statements](https://github.com/porsager/postgres/blob/master/README.md#prepared-statements);
  [Supabase, Disabling prepared statements](https://supabase.com/docs/guides/troubleshooting/disabling-prepared-statements-qL8lEL)).
- **Session state:** `SET`/`RESET`, session-level advisory locks, `LISTEN`/`NOTIFY` and temp
  tables are lost between transactions. `SET LOCAL` and `pg_advisory_xact_lock` inside a
  transaction are transaction-scoped, so they still hold (Postgres semantics; not stated on the
  Supabase page).
- **Query pipelining:** "Transaction mode does not support query pipelining." postgres.js
  pipelines by default (`max_pipeline: 100` in 3.4.9 `src/index.js` defaults), and `sql.begin`
  can pipeline when the callback returns an array of queries. Not verified: whether this bites
  postgres.js over Supavisor in practice. The spike's commit awaits each query in turn.
- **`sql.begin` itself is fine:** a transaction-mode pooler hands the client one server
  connection from `BEGIN` to `COMMIT`/`ROLLBACK`, so the whole `sql.begin` scope runs on one
  backend. The postgres.js README names only `prepare: false` as the change for "PGBouncer in
  `transaction mode`", and notes PgBouncer 1.21+ can support named prepared statements. Not run
  against Supavisor in this repo.

## 3. Connections on Vercel (Fluid compute) and Supabase limits

### Vercel

- "As of April 23, 2025, fluid compute is enabled by default for new projects." Optimized
  concurrency: "multiple invocations [share] a single function instance" on Node.js
  ([Vercel, Fluid compute](https://vercel.com/docs/fluid-compute)).
- So a pool created at module scope is reused by concurrent and later requests on the same
  instance; new instances scale out, each with its own pool. Vercel's guide: create the pool in
  global scope, use "a relatively short idle timeout (e.g., 5 seconds)", don't set max pool size 1
  ("does not reduce total connections and harms concurrency in Fluid Compute"), and call
  `attachDatabasePool` so idle connections close before suspension, because "Idle connection
  timeouts don't run while suspended"
  ([Vercel KB, Connection pooling](https://vercel.com/kb/guide/connection-pooling-with-functions)).
- `attachDatabasePool` duck-types the pool and throws `"Unsupported database pool type"` for
  anything else (`@vercel/functions@3.11.3`, `db-connections/index.js`). A postgres.js `sql`
  object exposes `options`, `begin`, `reserve`, `end` and so on, but no `.on(...)` event hook,
  which every supported branch needs. **Inferred from source, not run:** postgres.js is not
  supported by `attachDatabasePool`.
- postgres.js defaults (3.4.9 `src/index.js`): `max: 10`, `idle_timeout: null` (connections stay
  open until `.end()`), `max_lifetime` random 30 to 60 min (`60 * (30 + Math.random() * 30)`;
  one README paragraph says 45 to 90), `connect_timeout: 30`. The README
  lists "using Postgres.js in a Serverless environment (Lambda, etc.)" as a reason to set
  `idle_timeout` / `max_lifetime`
  ([README, Connection timeout](https://github.com/porsager/postgres/blob/master/README.md#connection-timeout)).
- Next.js route handlers run on Node.js by default (`runtime` default `'nodejs'`, `'edge'`
  deprecated; [Route Segment Config](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config)).
- IPv6: Supabase lists Vercel among hosts that "only accept IPv4 connections"
  ([Supabase, IPv4/IPv6 compatibility](https://supabase.com/docs/guides/troubleshooting/supabase--your-network-ipv4-and-ipv6-compatibility-cHe3BP)).
  So direct connections from Vercel need the IPv4 add-on; the shared pooler is IPv4 on all plans.

### Supabase limits

From [Supabase, Compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk):

| Compute | Database max connections | Pooler max clients |
| --- | --- | --- |
| Nano (Free plan) | 60 | 200 |
| Micro (smallest for paid orgs, so Pro) | 60 | 200 |
| Small | 90 | 400 |

- Paid organisations launch "only Micro and above"; Free gets Nano. Not verified here: whether
  Pro's compute credit covers Micro (the page doesn't say).
- Pool size: "conscientious about raising your pool size past 40% of the Database Max
  Connections" if PostgREST is heavily used, "Otherwise, you can commit 80% to the pool"; it
  "applies per database user (role)"
  ([Supabase, Connection management](https://supabase.com/docs/guides/database/connection-management)).
- Arithmetic (mine): with postgres.js `max: 10` per instance, six Vercel instances on a direct or
  session-mode connection would take all 60 backends. Through transaction mode, instances hold
  pooler client slots (200) and Supavisor multiplexes them onto its server pool.

## 4. Local stack and CI vs hosted

- Local stack (`supabase/config.toml`): Postgres `major_version = 17`, DB on 55322, and
  `[db.pooler] enabled = false`, `port = 55329`, `pool_mode = "transaction"`,
  `default_pool_size = 20`, `max_client_conn = 100`. So `pnpm db:env` gives a **direct**
  connection today, while hosted-from-Vercel would go through the pooler.
- The local pooler is Supavisor: CLI v2.122.0 pins `supabase/supavisor:2.9.13` and
  `supabase/postgres:17.11.0.006` (`apps/cli-go/pkg/config/templates/Dockerfile`), and
  `apps/cli/src/commands/start/services/supavisor.service.ts` maps `pool_mode` to Supavisor's
  6543 (transaction) or 5432 (session) inside the container, published on `db.pooler.port`.
  Supabase's [CLI config reference](https://supabase.com/docs/guides/local-development/cli/config)
  still calls it "the local PgBouncer service"; the source is newer than the doc.
- CI: Supabase documents `supabase/setup-cli@v1` then `supabase db start` (database only) or
  `supabase start` in GitHub Actions
  ([Supabase, Testing in CI](https://supabase.com/docs/guides/deployment/ci/testing)). This repo's
  `.github/workflows/*` start no database today.
- What would differ from production even with the pooler on: no IPv4/IPv6 or network hop, no
  Vercel Fluid instance reuse or suspension, and local pool sizes from `config.toml` rather than
  the compute tier.

## 5. bigint parsing

- postgres.js: "`bigint` … Postgres.js will return it as a string"; opt in to `BigInt` with
  `types: { bigint: postgres.BigInt }`
  ([README, Numbers, bigint, numeric](https://github.com/porsager/postgres/blob/master/README.md#numbers-bigint-numeric)).
- The spike instead parses `int8` to a JS number:
  `types: { bigint: { to: 20, from: [20], serialize: (x) => String(x), parse: (x) => Number(x) } }`
  (`prototypes/persistence/src/store-a.ts`, `connect`). `Number(x)` silently loses precision past
  2^53 − 1, which is why ADR-0001 keeps the `Number.isSafeInteger` check on `seq` and `at` at the
  store boundary as the guard.
- PostgREST returns JSON; Postgres renders `bigint` as a JSON number there, so supabase-js hands
  back a JS number with the same 2^53 caveat (not verified against a live PostgREST in this
  research).

## Open in the repo

- [Check transaction use under load: postgres.js UNSAFE_TRANSACTION in the B100 stress run](https://github.com/sssoto17/sunny-pastures/issues/28)
  is still open. In 3.4.9 `src/connection.js`, the error fires when a result's command is `BEGIN`
  on a connection that is not reserved and `max !== 1`. `sql.begin` marks the connection reserved
  in its `onexecute` hook. Its cause in the spike run is not established here.
