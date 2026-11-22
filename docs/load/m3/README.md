# M3 load and concurrency run

The game API under load (#388): `next start` and the local Supabase stack, driven by Locust with
ADR-0001's method, inside the load devcontainer (ADR-0009, its cloud config). Run on 22 Nov 2026 by
`tools/load/matrix.sh`; the harness and how to rerun it are in
[`tools/load/README.md`](../../../tools/load/README.md). These are the numbers MUST-13.8 to 13.10
read (`docs/requirements/spec.md`, filed by #33).

## Verdict

<!-- prettier-ignore -->
| Criterion | Limit | Measured | Pass |
| --- | --- | --- | --- |
| MUST-13.8, action p95 at 200 players (Locust, 3 runs pooled) | < 28 ms | **20 ms** (n = 8,666) | yes |
| MUST-13.8, server `total` p95 at 200 players (same runs) | < 28 ms | **14.5 ms** | yes |
| MUST-13.9, worst-case `load` p95 (99-action tail, every normal run) | < 50 ms | **6.6 ms** (n = 629) | yes |
| Lost updates, every run (seqs rebuilt from the log) | 0 | **0** | yes |
| `UNSAFE_TRANSACTION` in the server log, every run | 0 | **0** | yes |
| Concurrency: 1,000 harvest-and-harvest pairs on one farm each | 0 lost | **0 lost**, 988 collisions | yes |
| Stress (200 players, no wait): failures / lost updates / `UNSAFE_TRANSACTION` | reported | **0 / 0 / 0** | n/a |

## The machine

From [`machine.json`](machine.json): one Claude cloud VM, Intel Xeon @ 2.10 GHz, 4 vCPUs, 15.7 GiB,
kernel 6.18 on Ubuntu 24.04.5 (the host); the devcontainer is Debian 12 (`node:24-bookworm` at its
pinned digest), Node 24.22.3, Python 3.13.18, uv 0.13.6, Locust 2.47.0, Docker 29.10.0, Postgres
17.11. Locust, `next start` and Postgres share the machine, as in the spike.

**Method difference from ADR-0001:** Postgres runs in a container (the Supabase stack's
`supabase_db`, beside the devcontainer on the host's network; ADR-0009, section 3), where the spike
ran PGDG Postgres 17 natively. The app is the real one (Next.js `next start`, Supabase Auth tokens
verified on every request, Drizzle over postgres.js 4.1.1 with its default pool of 10), where the
spike's was a bare `node:http` server.

## Method

ADR-0001's, with the changes #388 and ADR-0007 set:

- **Players** sign up anonymously on the stack's Auth, one per farm. Each run starts from an empty
  database (`pnpm db:reset`), then seeds every farm's history: farm _i_ gets 1,000 + (_i_ × 37) mod
  100 accepted actions (plant, harvest, deliver, discard), so replay tails spread across 0 to 99.
  The rows are written through the admin database connection, built by the same rules and
  `stateHash` the server runs (`tools/load/seed.mjs`); every first read in the run replays them.
- **The mix:** 80% active players (a tap every 2–8 s, 15% of taps a `GET /api/farm` whatever else
  they could do, the rest plant, harvest or deliver as their farm allows); 20% returning players.
  The API has **no clock header**, so a returning farm's history ends 8 hours before the run
  (backdated), and each visit takes a fresh one: its first read is the offline return. Ten fresh
  farms per returning player (two in the stress run); after that it revisits its last farm.
- **Runs:** 50 and 200 players, 1 min warm-up plus 5 min measured, 3 runs each, then the stress run
  (200 players, no wait, 1 min warm-up plus 2 min measured), then the concurrency pairs. Locust's
  stats are reset after the warm-up; the request log is cut to the same window.
- **Server-Timing:** every response's `load`, `sim`, `commit` and `total` (ms), logged per request
  by Locust from the header, with the seq the server loaded, so the tail is that seq mod 100 (B100).
- **Lost updates:** after each run, each farm's seq rebuilt from its log must equal its seeded seq
  plus the actions the run saw accepted, with no gap, and every accepted action's key must sit at
  the seq its answer gave (`seed.mjs verify`, [`verify.json`](r1-u200/verify.json) per run).
- **Concurrency (M3's stand-in for MUST-13.5):** 1,000 farms, each with wheat ripe on two plots; per
  farm, two harvests sent at the same moment on two kept-alive connections, both with
  `expectedSeq: 2`. The gift version is MUST-13.5 itself, in M6.

## Results

Percentiles are nearest-rank over pooled histograms (Locust's for client time, 0.1 ms buckets for
the server's). [`results.csv`](results.csv) holds every group and run;
`tools/load/results.py report` rebuilds it from the run folders.

### Normal runs

<!-- prettier-ignore -->
| | 50 players | 200 players |
| --- | --- | --- |
| Requests / failures (3 runs) | 8,491 / 0 | 33,692 / 0 |
| Requests per second | 9.4 | 37.4 |
| Action p50 / p95 / p99, client (ms) | 12 / 20 / 31 | 11 / 20 / 30 |
| Action p95 per run, client (ms) | 19, 21, 22 | 19, 19, 21 |
| Action `total` p50 / p95, server (ms) | 8.7 / 15.5 | 8.1 / 14.5 |
| Action `load` p50 / p95 (ms) | 4.1 / 7.5 | 3.8 / 7.3 |
| Action `sim` p50 / p95 (ms) | 0.2 / 0.8 | 0.2 / 0.5 |
| Action `commit` p50 / p95 (ms) | 3.0 / 6.6 | 2.8 / 6.4 |
| Worst-case `load` p95, 99-action tail (ms) | 6.7 (n = 97) | 6.6 (n = 532) |
| Offline return p95, client (ms) | 12 (n = 228) | 13 (n = 952) |
| Lost updates / gaps / `UNSAFE_TRANSACTION` | 0 / 0 / 0 | 0 / 0 / 0 |

Pooled over all six normal runs, the worst-case `load` p95 is 6.6 ms (n = 629), MUST-13.9's number.
Against the spike's B100 (ADR-0001, Results): action p95 at 200 players 20 ms here against 8 ms, and
the worst case 6.6 ms against 2.46 ms. The real stack does more per request than the spike's server
did: verify the bearer token, run Next's route handling, and replay the full sim.

### Stress run (reported, not judged)

200 players with no wait, 2 min measured ([`stress-u200/`](stress-u200/)): 50,731 requests at **423
per second**, 0 failures, 0 lost updates, 0 `UNSAFE_TRANSACTION`. The server is saturated, and the
time goes to `load`, which includes waiting for one of postgres.js's 10 pooled connections:

<!-- prettier-ignore -->
| Server p95 (ms) | M3 | Spike B100 (MUST-13.10's baseline) |
| --- | --- | --- |
| Action `total` | 985.4 | 24.07 |
| Action `load` / `sim` / `commit` | 773.0 / 0.6 / 263.2 | 15.14 / 0.15 / 16.29 |
| Read `total` | 512.3 | 13.08 |
| Worst-case `load` | 516.9 (n = 893) | 13.44 |
| Client action p50 / p95 | 800 / 1,000 | – / 100 |

Of the measured requests, 1,332 were actions (all accepted) and the rest reads: under no wait a
player whose wheat is still growing (2 min) can only look. The whole run, warm-up included,
committed 2,618 actions, every one found in the log at its answered seq.

### Concurrency

From [`concurrency/`](concurrency/): 1,000 pairs, 2,000 harvests, all answered 200. In 988 pairs the
two collided and the loser committed on a retry (`answer.retries` ≥ 1); in the other 12 the second
arrived after the first committed and ran on its farm (rebased, no retry). **0 lost updates**: every
farm's log ends at seq 4 with both harvests' keys at their answered seqs.

## How it ran

<!-- prettier-ignore -->
| Step | Command (in the devcontainer unless noted) | Exit | Excerpt |
| --- | --- | --- | --- |
| Docker | host: `nohup dockerd …`, then `docker info` | 0 | ready in 1 s; Docker Hub 429 on the image pull, so `mirror.gcr.io` became the daemon's registry mirror and served the same digest |
| Devcontainer | host: `pnpm exec devcontainer up --workspace-folder . --config .devcontainer/cloud/devcontainer.json` | 0 | `supabase_2.122.0_linux_amd64.tar.gz: OK`, `uv-x86_64-unknown-linux-gnu.tar.gz: OK`, `uv 0.13.6 installed.`, `{"outcome":"success",…}` |
| Stack | `pnpm supabase:check`; `pnpm db:start`; `pnpm db:reset`; `pnpm db:env` | 0 | CLI 2.122.0; every key `<hidden>`; `Reset the local database: migrations and seed applied.` |
| Build | `pnpm --dir apps/web build` | 0 | routes incl. `ƒ /api/farm`, `ƒ /api/farm/actions` |
| Matrix | `tools/load/matrix.sh` | 0 | `matrix: every run done`; each run's `verify.json` and `errors.json` here |
| Report | `python3 tools/load/results.py report docs/load/m3` | 0 | `results.csv` |

The matrix took four attempts before every run counted; `matrix.sh` skips finished runs and a failed
run's folder was deleted before the next, so nothing was mixed across attempts. The first r1-u50 had
one failed action, on a connection Node's 5 s keep-alive timeout had closed while the player waited:
`run.sh` now gives `next start` a 65 s keep-alive, as the spike's server had, and every run was then
done afresh. The first stress run drained the shared pool of returning farms and left later-spawned
returning players with none (an `AttributeError` in Locust, no request sent); a second try set farms
aside from the shared pool and ran it dry at spawn (`StopIteration`). Each returning player now has
its own first farm, set aside before the rest, and the stress run and the concurrency pairs ran on
the fourth attempt, after the VM had restarted. No command printed a key, token or database URL.
