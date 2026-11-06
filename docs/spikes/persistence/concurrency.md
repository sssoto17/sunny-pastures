# Concurrency check: two requests on one farm at once

Part of the persistence spike (ADR-0001, issue #8). It asks whether each store keeps both effects
when two actions reach one farm at the same instant, and whether a resent request is applied
exactly once. The script is `prototypes/persistence/src/concurrency.ts` on `prototype/persistence`.

## What runs

For each store configuration (A, B1, B25, B100), the script starts the spike server
(`src/server.ts`, real clock) and runs 1,000 pairs per scenario. The two requests of a pair go
over HTTP together (`Promise.all` of two `fetch` calls), each pair on a farm of its own. Farms are
set up in-process through the same handler and store, with a clock 10 minutes in the past, so
their wheat is ripe when the pair arrives. No server clock is changed.

| Scenario | The pair | Counts as a lost update when |
| --- | --- | --- |
| gift+harvest | `sendGift` (1 wheat) and `harvest` on farm X, both sent with the same `expectedSeq` | seq didn't go up by exactly 2, the wheat isn't `before − 1 + yield`, plot 1 isn't empty, or there's no gift row `<X>:<seq>` |
| same key | one `harvest`, sent twice at once with one idempotency key | seq didn't go up by exactly 1, or the two answers differ |
| control | X sends Y a gift while Y harvests (two farms) | either farm's seq didn't go up by exactly 1, or there's no gift row |

The harvest yield comes from the sim's own draw. Sending a gift doesn't touch the farm's PRNG, so
the yield is the same whichever action commits first.

Columns: **Retries** sums `retries` over the 200 answers (a conflict at commit, retried on top of
the new farm). **503s** counts requests still in conflict after 3 retries. **Duplicates** counts
pairs whose two answers are identical, meaning one request got the stored first answer. **Other
errors** counts any other non-200.

## Results

Run on 6 Nov 2026 in a cloud container: Node v24.22.2, PostgreSQL 16.15 on the same host, 4 CPUs.

| Store | Scenario | Pairs | Lost updates | Retries | 503s | Duplicates | Other errors | Time (s) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | gift+harvest | 1000 | 0 | 993 | 0 | 0 | 0 | 10.9 |
| A | same key | 1000 | 0 | 0 | 0 | 1000 | 0 | 5.6 |
| A | control | 1000 | 0 | 0 | 0 | 0 | 0 | 9.8 |
| B1 | gift+harvest | 1000 | 0 | 991 | 0 | 0 | 0 | 14.9 |
| B1 | same key | 1000 | 0 | 0 | 0 | 1000 | 0 | 7.2 |
| B1 | control | 1000 | 0 | 0 | 0 | 0 | 0 | 11.7 |
| B25 | gift+harvest | 1000 | 0 | 994 | 0 | 0 | 0 | 12.2 |
| B25 | same key | 1000 | 0 | 0 | 0 | 1000 | 0 | 5.7 |
| B25 | control | 1000 | 0 | 0 | 0 | 0 | 0 | 10.1 |
| B100 | gift+harvest | 1000 | 0 | 992 | 0 | 0 | 0 | 12.0 |
| B100 | same key | 1000 | 0 | 0 | 0 | 1000 | 0 | 5.8 |
| B100 | control | 1000 | 0 | 0 | 0 | 0 | 0 | 9.8 |

- **No lost updates and no 503s in any store.** On one farm almost every pair collides: about 990
  retries per 1,000 pairs, so the loser usually commits on its first retry. The script counts
  totals, so it doesn't show whether any single request needed more than one.
- **Same key:** every pair gave one commit and one identical answer, with seq up by exactly 1.
- **Control:** 0 retries in every store, because a gift never writes the recipient's farm.
- The times include setup and checks, so they aren't latencies. #10 measures timing.

## Checks that the script can fail

Each check below was run once on a deliberately broken copy, and the code was restored afterwards:

- With store A's write not checking `seq`, 98 of 100 gift+harvest pairs were lost updates (for
  example, "seq 3 → 4, wheat 2 → 4": the gift was overwritten).
- With the handler's re-check before a 422 removed (see below), 1 of 300 same-key pairs on A was a
  422 ("plot 0 is not ready") instead of the first answer.

## Finding: a resend can race its own first commit

`processed` runs before the sim, so a resend gets its first answer even when the rules would now
refuse it (ADR-0001, amended after #5). With two identical requests at once, that check can miss:
request 2 asks `processed` just before request 1 commits and finds nothing, then loads the farm
just after the commit and finds the plot already harvested. The rules refuse, and request 2 would
answer 422. The commit's key claim doesn't help, because request 2 never reaches `commit`.

The fix in `handler.ts`: before any 422, ask `processed` once more. If request 1 committed before
request 2's load, its answer is visible by then. This costs one query, on refusals only. A
handler test reproduces the race deterministically.

## Run it

```bash
pnpm --filter @sunny-pastures/persistence-spike concurrency
```

Optional arguments: the number of pairs (default 1000) and the configurations (default
`A,B1,B25,B100`). It reads `DATABASE_URL` from the repo `.env` and never prints it.
