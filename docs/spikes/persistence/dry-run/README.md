# Dry run of the matrix runner (#15): proves the runner, not the stores

Two configurations, 30 s each (10 s warm-up discarded, 20 s measured), at 50 players: A and B100.
Run on 6 Nov 2026 in a Claude cloud session on the machine described in
[`../matrix/README.md`](../matrix/README.md) (`machine.json` here), with **Postgres 16.15**,
because this session's network refuses `apt.postgresql.org`. The numbers show that the runner,
the warm-up cut and the new moves work. They are far too short to be results and don't feed
ADR-0001's decision rule.

```bash
MATRIX_OUT=docs/spikes/persistence/dry-run STORES=A,B100 USERS=50 RUNS=1 WARMUP_S=10 MEASURE_S=20 \
  pnpm --filter @sunny-pastures/persistence-spike matrix
```

## What it showed

1. **One configuration per step, committed and pushed after each.** The first start used
   `LIMIT=1`: it ran `r1-A-u50`, wrote `done.json` last, then committed and pushed that folder with
   `machine.json` (commit "load(matrix): r1-A-u50 (#11)").
2. **Two runners must never overlap, so now they can't.** The second start was meant to be
   interrupted, but the kill missed and that runner kept going in the background. Two more starts
   then ran beside it: each deleted its half-written `r1-B100-u50` folder, dropped its live
   schema, and failed to seed with a 500 from its server on the shared port. So the runner now
   takes a pid lock (`load/results/matrix.lock`, gitignored), and a lock whose process is gone is
   taken over. Nothing from those attempts is in these results.
3. **A stopped session's half-written configuration runs again.** The background runner was then
   interrupted (SIGINT to its process group) while Locust ran, leaving `r1-B100-u50` with Locust's
   partial output and no `done.json`. The next start counted 1 done and 1 to run, deleted the
   half-written folder, dropped and recreated schema `load_r1_b100_u50`, and ran it from scratch.
   A second runner started meanwhile exited 4: "another matrix runner (pid …) holds
   …/matrix.lock".
4. **Done configurations are skipped.** A third start printed `matrix: 2 configurations, 2 done,
   0 to run` and exited 0.
5. **Warm-up is discarded from both sources.** Locust's stats are reset after `WARMUP_S`, and
   `summarize.py` cuts `server.csv` to `window.json`. Locust and the server agree on the
   measured request count (186 = 5 + 181 for A; 179 = 2 + 177 for B100).
6. **Bake and collect are in the live mix and in seeded history.** B100's log after the run:
   seeded plus live, plant 24,699, harvest 24,478, bake 1,840, collect 1,690; live only, harvest
   147, plant 92, bake 22, collect 21. No request failed.
7. **A fresh schema per configuration:** `load_r1_a_u50` and `load_r1_b100_u50`.

## Read/write share

Reads were about 17% of requests in the smoke run (#10), when the only moves were plant and
harvest. With bake and collect, an active player nearly always has something to do, so in these
20 s windows reads were 2.7% (A, 5 of 186) and 1.1% (B100, 2 of 179), all from returning
players. A 5-minute window may differ as wheat and bakery slots run out. This is an open question
for #11, not something the runner decides.

## Summary (`summarize.py`)


### r1-A-u50

| Request | Requests | Failures | p50 (ms) | p95 (ms) |
|---|---:|---:|---:|---:|
| GET /farms/:id [return] | 5 | 0 | 3 | 3 |
| POST /farms/:id/actions [active] | 165 | 0 | 6 | 9 |
| POST /farms/:id/actions [return] | 16 | 0 | 6 | 21 |
| **All** | 186 | 0 | 6 | 9 |

Server rows from the measured window only (warm-up of 10 s discarded).

| Route | Status | n | load p50/p95 | sim p50/p95 | commit p50/p95 | total p50/p95 |
|---|---|---:|---:|---:|---:|---:|
| GET read | 200 | 5 | 0.63 / 0.98 | 0.09 / 0.10 | 0.00 / 0.00 | 0.79 / 1.17 |
| POST action | 200 | 181 | 1.09 / 1.63 | 0.12 / 0.18 | 2.18 / 3.73 | 3.75 / 5.91 |

Storage (load_r1_a_u50): 16,973,824 → 17,096,704 bytes; rows farms 50 → 50, processed_keys 52,425 → 52,711

### r1-B100-u50

| Request | Requests | Failures | p50 (ms) | p95 (ms) |
|---|---:|---:|---:|---:|
| GET /farms/:id [return] | 2 | 0 | 3 | 3 |
| POST /farms/:id/actions [active] | 158 | 0 | 6 | 9 |
| POST /farms/:id/actions [return] | 19 | 0 | 6 | 8 |
| **All** | 179 | 0 | 6 | 9 |

Server rows from the measured window only (warm-up of 10 s discarded).

| Route | Status | n | load p50/p95 | sim p50/p95 | commit p50/p95 | total p50/p95 |
|---|---|---:|---:|---:|---:|---:|
| GET read | 200 | 2 | 1.23 / 1.32 | 0.07 / 0.08 | 0.00 / 0.00 | 1.40 / 1.44 |
| POST action | 200 | 177 | 1.74 / 2.91 | 0.10 / 0.16 | 1.71 / 2.54 | 3.93 / 6.14 |

Storage (load_r1_b100_u50): 25,886,720 → 26,025,984 bytes; rows actions 52,425 → 52,707, snapshots 500 → 503
