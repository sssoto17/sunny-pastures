# Research: what raises postgres.js UNSAFE_TRANSACTION inside sql.begin

For [Research: what raises postgres.js UNSAFE_TRANSACTION inside sql.begin](https://github.com/sssoto17/sunny-pastures/issues/327),
feeding [Check transaction use under load: postgres.js UNSAFE_TRANSACTION in the B100 stress run](https://github.com/sssoto17/sunny-pastures/issues/28).
Researched 16 Nov 2026. Facts only; nothing is fixed here.

## Answer

In postgres.js 3.4.9, the only thing that raises `UNSAFE_TRANSACTION` is a `BEGIN` whose
`CommandComplete` arrives on a connection that isn't reserved, while `max !== 1`. `sql.begin`
can trigger that by itself: it sends its own `BEGIN` through the shared pool and reserves the
connection in an `onexecute` hook that a short-circuit `&&` chain skips whenever the `BEGIN`
filled the connection's pipeline (`max_pipeline`, 100 by default) or the socket write reported
backpressure. This is a known driver bug ([porsager/postgres#1189](https://github.com/porsager/postgres/issues/1189),
also [#823](https://github.com/porsager/postgres/issues/823)). The spike's store code uses the
transaction handle for every query inside `sql.begin` and never sends a manual `BEGIN`, and a
query on the outer `sql` would not raise this error in 3.4.9 anyway. The B100 failure fits the
driver bug: the request failed during `sql.begin` before the callback wrote anything, under a
saturated pool. postgres.js 4.x reserves the connection before sending `BEGIN`, so this path no
longer exists there.

Not reproduced: which of the two triggers (pipeline boundary or backpressure) fired in the
stress run is not known, and the spike's server log of the stack trace was not kept.

## Versions

- Spike (`prototype/persistence`): `postgres` **3.4.9**, pinned in
  `prototypes/persistence/package.json` and `pnpm-lock.yaml`. `connect()` sets no `max` and no
  `max_pipeline`, so the defaults apply: `max: 10`, `max_pipeline: 100`
  ([store-a.ts L15-L21](https://github.com/sssoto17/sunny-pastures/blob/prototype/persistence/prototypes/persistence/src/store-a.ts#L15-L21);
  defaults at [index.js L449](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js#L449)
  and [L455](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js#L455)).
- Current: **4.1.1** (npm `latest`, published 11 Nov 2026). 4.0.0 came out 29 Oct 2026, 4.1.0
  on 5 Nov 2026. On 16 Nov, 4.1.1 is younger than the 7-day `minimumReleaseAge` in
  `pnpm-workspace.yaml`; 4.0.0 and 4.1.0 are not.
- The npm tarballs' `src/` files were checked byte-for-byte against the GitHub tags `v3.4.9` and
  `v4.1.1`, so the line links below match what was installed.

## postgres.js 3.4.9: every path that raises it

One site. `CommandComplete` in `src/connection.js`
([L605-L606](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js#L605-L606)):

```js
if (result.command === 'BEGIN' && max !== 1 && !connection.reserved)
  return errored(Errors.generic('UNSAFE_TRANSACTION', 'Only use sql.begin, sql.reserved or max: 1'))
```

So it fires when, and only when, the server completes a `BEGIN` on a connection with no
`connection.reserved` and the pool's `max` isn't 1. The ways a `BEGIN` reaches an unreserved
connection:

1. **A manual `BEGIN` on the pool** (`` sql`begin` `` or `sql.unsafe('begin')` on the outer
   `sql`). The documented case
   ([README "UNSAFE_TRANSACTION"](https://github.com/porsager/postgres/blob/v3.4.9/README.md#unsafe_transaction)).
2. **`sql.begin`'s own `BEGIN`, when the reservation hook is skipped.** `sql.begin` sends
   `BEGIN` through the pool with `sql.unsafe('begin …', [], { onexecute }).execute()`
   ([index.js L242](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js#L242)).
   `onexecute` is what reserves the connection
   ([L299-L305](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js#L299-L305)). It is
   called from `execute()` as the last term of the expression that says whether the connection
   can take more queries
   ([connection.js L173-L177](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js#L173-L177)):

   ```js
   return write(toBuffer(q))
     && !q.describeFirst
     && !q.cursorFn
     && sent.length < max_pipeline
     && (!q.options.onexecute || q.options.onexecute(connection))
   ```

   The bytes are already written (or buffered) when the earlier terms are evaluated, so if any
   of them is false the `BEGIN` goes to the server without the connection being reserved:
   - `sent.length < max_pipeline` is false when the `BEGIN` is the query that fills the
     connection's pipeline (the 100th queued query by default). This is the trigger
     reproduced deterministically upstream
     ([#1189](https://github.com/porsager/postgres/issues/1189)).
   - `write(...)` returns false when the buffered chunk reaches 1024 bytes, so it is flushed
     synchronously, and `socket.write` reports backpressure
     ([L246-L259](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js#L246-L259)).
     #1189 says this path follows from the source but was not reproduced separately.
   - `describeFirst` and `cursorFn` are false for `sql.begin`'s `BEGIN` (no parameters, no
     cursor; [L238](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js#L238)),
     so those terms don't apply.

   With `max_pipeline: 0` the hook never runs, so every `sql.begin` fails
   ([#1210](https://github.com/porsager/postgres/issues/1210),
   [#1264](https://github.com/porsager/postgres/issues/1264)).

   A `BEGIN` is pipelined onto a busy connection when the pool has no open or closed
   connection: `handler` sends to `busy.shift()`
   ([index.js L329-L342](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js#L329-L342)),
   and `onopen` drains up to `ceil(queue / (connecting + 1))` queued queries onto one connection
   until `execute` returns false
   ([L401-L419](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js#L401-L419)). So
   the trigger needs a saturated pool with a deep queue.

What happens next (from the source and #1189, not observed in the spike): the `BEGIN` query is
rejected, so `sql.begin` throws before the callback runs and before `connection` is set. The
server is now inside a transaction on that connection, which isn't reserved, so it goes back to
the pool through `onopen` and later pool queries run inside the open transaction. The fix PR
[#1218](https://github.com/porsager/postgres/pull/1218) states this, and a comment on #1189
reports autocommit writes on such a connection acknowledged and then rolled back when the
connection closed. #1218 was closed unmerged; #1189 was closed on 29 Oct 2026, the day 4.0.0
was released.

Not a trigger in 3.4.9: **a query on the outer `sql` inside the callback.** It just runs on
another pool connection, outside the transaction, with no error. It is a correctness bug, but not
this error.

## postgres.js 4.1.1: what raises it now

`sql.begin` takes a lease on a connection first (`pool.lease('transaction')`), then sends
`BEGIN` on it ([index.js L219-L238](https://github.com/porsager/postgres/blob/v4.1.1/src/index.js#L219-L238)),
so the 3.4.9 reservation race has no equivalent. The sites:

1. **A pool query leaves its connection in a transaction.** In `ReadyForQuery`, a status other
   than idle on a connection with no lease, while `max !== 1`, calls `unsafe(item)`
   ([connection.js L1117](https://github.com/porsager/postgres/blob/v4.1.1/src/connection.js#L1117)),
   which rejects the query and everything pipelined behind it with `UNSAFE_TRANSACTION: Only use
   sql.begin, sql.reserved or max: 1` and queues a `rollback`
   ([L1055-L1061](https://github.com/porsager/postgres/blob/v4.1.1/src/connection.js#L1055-L1061)).
   This is the manual-`BEGIN` case, now rolled back instead of left open
   ([README](https://github.com/porsager/postgres/blob/v4.1.1/README.md#unsafe_transaction);
   v4.0.0 release notes, "An unsafe `begin`").
2. **A query on a transaction's `sql` after the transaction ended**: `UNSAFE_TRANSACTION: The
   transaction has ended`
   ([index.js L256](https://github.com/porsager/postgres/blob/v4.1.1/src/index.js#L256)), and
   the pool's equivalent for a released lease, "The transaction has ended" or "The reserve has
   ended" ([pool.js L754-L756](https://github.com/porsager/postgres/blob/v4.1.1/src/pool.js#L754-L756),
   used at [L179](https://github.com/porsager/postgres/blob/v4.1.1/src/pool.js#L179) and
   [L721](https://github.com/porsager/postgres/blob/v4.1.1/src/pool.js#L721)). In 3.4.9 such a
   query ran on whatever connection it then had (v4.0.0 release notes, "A released connection
   stays released"; see also [#1320](https://github.com/porsager/postgres/issues/1320)).
3. **A cursor read after its transaction or lease moved on**: `UNSAFE_TRANSACTION: The cursor
   outlived its transaction`
   ([connection.js L1281](https://github.com/porsager/postgres/blob/v4.1.1/src/connection.js#L1281),
   [L1290-L1292](https://github.com/porsager/postgres/blob/v4.1.1/src/connection.js#L1290-L1292)).

The 4.x message on the spike's failure (`Only use sql.begin, sql.reserved or max: 1`) is the
same text as 3.4.9's, so the text alone doesn't tell the versions apart; the spike ran 3.4.9.

## The spike's code against these paths

- **Every query inside the transaction uses `tx`.** Store B's commit
  ([store-b.ts L122-L159](https://github.com/sssoto17/sunny-pastures/blob/prototype/persistence/prototypes/persistence/src/store-b.ts#L122-L159))
  runs the append, the duplicate check and the snapshot write on `tx`, and passes `tx` to
  `inbox.forCommit`
  ([L144](https://github.com/sssoto17/sunny-pastures/blob/prototype/persistence/prototypes/persistence/src/store-b.ts#L144)).
  The inbox's `send`, `claim` and `read` use only the client they are given, including `q(schema)`
  for the identifier
  ([inbox.ts L55-L100](https://github.com/sssoto17/sunny-pastures/blob/prototype/persistence/prototypes/persistence/src/inbox.ts#L55-L100)).
  Every `await` in the callback is awaited before the callback returns, so no query outlives
  the transaction. Store A's commit is the same shape
  ([store-a.ts L79](https://github.com/sssoto17/sunny-pastures/blob/prototype/persistence/prototypes/persistence/src/store-a.ts#L79)).
- **No manual `BEGIN`.** `git grep -i begin` over `prototypes/persistence/src` finds only the two
  `sql.begin` calls; there is no `sql.reserve` and no `max` or `max_pipeline` option.
- **The handler is sequential.** `handler.ts` awaits `processed`, `gift`, `load` and `commit`
  one at a time, so a request has no concurrent pool query racing its own transaction.
- So the spike can't hit path 1 (manual `BEGIN`) and, in 3.4.9, a stray outer-`sql` query
  wouldn't raise this error. The remaining path is `sql.begin`'s own `BEGIN` skipping
  `onexecute`.

## What in the stress run fits

From [`results.md`, "Stress runs"](https://github.com/sssoto17/sunny-pastures/blob/prototype/persistence/docs/spikes/persistence/results.md)
and `matrix/stress-B100-u200/` on `prototype/persistence`:

- **A saturated pool.** 200 players with no wait, about 1,465 requests/s, against the default 10
  connections. That is the condition under which `BEGIN` is pipelined onto a busy connection and
  can land at the pipeline boundary or meet socket backpressure.
- **It failed in `sql.begin` before anything was written.** The `server.csv` row
  (`1793996953928,B100,POST,none,,500,53.311,0,14.94,71.83,,0`) has a commit time of 14.94 ms
  and a route of `none`: `app.ts`'s catch replaces the route with `none` for any thrown error.
  The 14.94 ms is the time spent awaiting `sql.begin`; with the bug, that is the `BEGIN` round
  trip, after which `sql.begin` throws without running the callback. That matches "nothing was
  committed" and the rebuilt seqs matching the log.
- **Rare.** One in about 176k requests. The pipeline-boundary trigger needs `BEGIN` to be exactly
  the query that fills a connection's queue, which matches an intermittent failure.
- **No lost updates, consistent with the source.** Every spike write is inside `sql.begin`, so
  the leaked open transaction (above) would only have held reads until a later `sql.begin` on
  that connection sent `BEGIN` (a warning, which the spike's `onnotice` drops) and `COMMIT`. This
  is inferred, not checked: the spike didn't log connection states.
- **Why only B100 is not established.** B100 has the slowest server-side load (replaying up to
  99 actions; action p95 24.1 ms against A's 14.7 ms), which keeps the event loop and the pool
  busier, so queues are deeper. That is a plausible reason, not a measured one; one failure in
  one run per store can't separate B100 from chance.

## For the M3 persistence layer and the driver choice

- On 3.4.9 the error can happen with correct application code: using `tx` everywhere does not
  prevent it. Ways around it on 3.x that follow from the source: keep the pool from saturating
  (more connections than concurrent requests, or a request queue in front of the store), or
  open transactions on a reserved connection. None of these was tested here.
- On 4.x the race is gone by construction (lease, then `BEGIN`), and the remaining
  `UNSAFE_TRANSACTION` paths are application mistakes: a manual `BEGIN` on the pool, or a query
  on `tx` after the transaction ended. 4.0.0 is a major release with other breaking changes
  (its release notes and the README's migration section list them).
- Issue #28's lint or test check ("code inside the transaction uses the outer `sql`") catches a
  real bug class (queries silently outside the transaction), but on 3.4.9 not this error.

## Sources

- postgres.js source at tags [v3.4.9](https://github.com/porsager/postgres/tree/v3.4.9) and
  [v4.1.1](https://github.com/porsager/postgres/tree/v4.1.1); npm registry metadata for release
  dates.
- Upstream issues and PR: [#1189](https://github.com/porsager/postgres/issues/1189),
  [#823](https://github.com/porsager/postgres/issues/823),
  [#1210](https://github.com/porsager/postgres/issues/1210),
  [#1264](https://github.com/porsager/postgres/issues/1264),
  [#1320](https://github.com/porsager/postgres/issues/1320),
  [PR #1218](https://github.com/porsager/postgres/pull/1218) (closed unmerged).
- [postgres.js v4.0.0 release notes](https://github.com/porsager/postgres/releases/tag/v4.0.0).
- Spike code and data on `prototype/persistence`: `prototypes/persistence/src/{store-a,store-b,inbox,stores,server,app,handler}.ts`,
  `docs/spikes/persistence/results.md`, `docs/spikes/persistence/matrix/stress-B100-u200/`.
