# Load matrix: where and how it runs (#15, results for #11)

ADR-0001's load matrix runs in one Claude cloud environment, not on the WSL2 laptop, so the
numbers come from a clean, dedicated machine. Locust, the spike server and Postgres run **on the
same VM** (ADR-0001 "Method"): a network hop would add the same delay to A and B and loosen the
2× term of the decision rule in B's favour. Every matrix run uses this one environment, and the
runner checks that (below).

This folder holds the matrix results: one folder per configuration (`r<run>-<store>-u<users>`,
`stress-<store>-u<users>`) and `machine.json`, written by the first configuration that runs. The
full matrix ran on 6 Nov 2026 on Postgres 17.11; the summary, the decision rule and the stress
runs are in [`../results.md`](../results.md), one row per configuration in
[`../results.csv`](../results.csv). The dry run that proved the
runner is in [`../dry-run/`](../dry-run/README.md).

## The machine

Measured in the cloud session that built the runner (6 Nov 2026), with the default cloud image.
The matrix's own `machine.json` is the record that counts; the runner refuses to resume on a
machine that doesn't match it.

| | |
| --- | --- |
| CPU | Intel(R) Xeon(R) Processor @ 2.10GHz (model name only; the VM doesn't expose more) |
| Cores | 4 vCPUs (1 socket, 4 cores, 1 thread per core) |
| RAM | 15.7 GiB (16,472,088 kB) |
| OS | Ubuntu 24.04.5 LTS, kernel 6.18.44 (a Firecracker microVM) |
| Postgres | **17.11** (PGDG) for the matrix (`machine.json`); 16.15 (Ubuntu's) in the session that built the runner |
| Node | v24.22.2 (the image's `/opt/node24`) |
| pnpm | 12.15.0 (Corepack) |
| uv / Python | uv 0.13.6 (PyPI), Python 3.13.18 (uv-managed) |
| Locust | 2.47.0 |

## The environment to create in claude.ai (admin)

Create it once from the cloud environment menu, then start every matrix session in it.

- **Name:** `sunny-pastures-load` (any name; the README and ADR-0001 refer to "the load
  environment").
- **Repository:** `sssoto17/sunny-pastures`.
- **Network access:** **Limited**, with **Allow package managers** ticked (npm, PyPI, Ubuntu's
  apt), plus these under **Allowed domains**:
  - `apt.postgresql.org` (port 443): Postgres 17 from PGDG, the local stack's major (#19). Its
    signing key ships with Ubuntu's `postgresql-common`, so no other PostgreSQL host is needed.
    Without it the setup script warns and falls back to Postgres 16.
  - `github.com` and `release-assets.githubusercontent.com`: `git push` of the results, and the
    Python build that `uv python install` downloads (GitHub redirects release downloads there).
  - `nodejs.org`: only if the image ever stops shipping `/opt/node24`.

  If the app shows **Custom** instead of Limited, choose it and tick the box that includes the
  default package managers. A broader level (Trusted, Full) also works, but Limited keeps the
  machine's traffic to what the run needs.
- **Setup script** (runs as root when the container starts; safe to run twice):

  ```bash
  #!/usr/bin/env bash
  # Sunny Pastures load matrix (#15): Node 24, pnpm, uv + Python + Locust, Postgres 17.
  # The repo may not be cloned yet when this runs; the session sources the same script again.
  for d in /home/user/sunny-pastures "$PWD"; do
    if [ -x "$d/prototypes/persistence/cloud-setup.sh" ]; then
      "$d/prototypes/persistence/cloud-setup.sh" || true
      break
    fi
  done
  ```

  The script needs no secrets: it makes a random Postgres password and writes `DATABASE_URL` to
  the repo's `.env` (mode 600, gitignored), never to output.
- **Environment variables:** none.

## Run the matrix

In a session in that environment, on `prototype/persistence` (or the branch the session may push):

```bash
. prototypes/persistence/cloud-setup.sh
```

```bash
pnpm --filter @sunny-pastures/persistence-spike gate
```

```bash
pnpm --filter @sunny-pastures/persistence-spike matrix
```

The gate runs first so the matrix only measures stores that are correct. The matrix defaults to
ADR-0001's: stores A, B1, B25 and B100 × 50 and 200 players × 3 runs, each with 60 s of
discarded warm-up and 300 s measured, so 24 configurations of about 7 minutes each (seeding
included), roughly 3 hours in all. Then one **stress run** per store (#11): 200 players with no
wait time, 60 s warm-up and 120 s measured, `stress-<store>-u200`, reported but not part of the
decision rule.

- **One configuration per step.** Order is run-major: run 1 of all eight store × player
  configurations, then run 2, then run 3, then the four stress runs. If the timebox cuts the
  matrix short, one run per configuration is already done, which is what ADR-0001 counts then.
- **Fresh schema per configuration** (`load_r<run>_<store>_u<users>`, through `STORE_SCHEMA`),
  dropped and recreated if a run is repeated. Schemas are kept afterwards, so storage stays
  inspectable and isn't cumulative across runs.
- **Resumable.** After each configuration, its folder (with `done.json` written last) is
  committed and pushed to the current branch. Started again, the runner skips every folder with
  `done.json`, deletes and reruns a half-written one, and first commits and pushes anything a
  stopped session left uncommitted. A paused or ended session loses at most one configuration.
- **One runner at a time.** A pid lock in `prototypes/persistence/load/results/matrix.lock`
  refuses a second runner (exit 4); a lock whose process is gone is taken over.
- **One machine.** `machine.json` records CPU, cores, RAM, OS and the Postgres, Node, Python and
  Locust versions. Resuming on a machine that differs exits 3 and names the fields;
  `MATRIX_ALLOW_MACHINE_CHANGE=1` overrides it, and the README must then say so.

Options (environment variables): `STORES=A,B25`, `USERS=50`, `RUNS=1`, `WARMUP_S`, `MEASURE_S`,
`LIMIT=<n>` (stop after n configurations), `MATRIX_OUT` (results folder), `PUSH=0` (commit only),
`COMMIT_TRAILER` (appended to each commit message), `STRESS=0` (no stress runs),
`STRESS_USERS`, `STRESS_WARMUP_S`, `STRESS_MEASURE_S`.

Each configuration folder holds what `load/smoke.sh` writes (`locust.json`, `locust_*.csv`,
`server.csv`, `server.log`, `seed.json`, `storage-before.json`, `storage-after.json`), plus
`window.json` (the measured window in epoch ms) and `done.json` (the configuration, its times and
the machine). Summarise with `prototypes/persistence/load/summarize.py`; it cuts `server.csv` to
the measured window, the same window as Locust's stats.

## Load mix

As decided on #11: active players tap every 2–8 s with plant, harvest, **bake** and **collect**.
A fixed **15%** of an active player's taps are a GET of their farm whatever else they could do,
and a tap with nothing to do is a GET as well. In the stress run (`SPIKE_NO_WAIT=1`) nobody waits:
not between taps, not between a returning player's visits. Returning players come back after 8 hours of
server time. Gifts stay out of the mix (the concurrency script, #8, covers them). Seeded history
plays the same four moves.
