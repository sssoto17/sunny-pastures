# Load and concurrency run (M3, #388)

M3's milestone run against the real game API (ADR-0007, "Load and concurrency"), with ADR-0001's
method, ported from the persistence spike's harness on `prototype/persistence`. Never in CI. The
results are in [`docs/load/m3/`](../../docs/load/m3/README.md).

A uv project of its own: `pyproject.toml` pins uv (`required-version`), Python 3.13 and Locust
2.47.0, and `exclude-newer` keeps out anything published less than 7 days before the lock (the
Python twin of pnpm's `minimumReleaseAge`). The concurrency script uses gevent and requests, which
Locust brings, so nothing else is added. The venv lives outside the repo (`UV_PROJECT_ENVIRONMENT`,
set by `run.sh`), so `eslint .` never reads the packages' own JS.

## Running it

Inside the load devcontainer (ADR-0009): in a Claude cloud session, the cloud config (its
amendment). `post-create.sh` installs uv from this project's pin.

```bash
nohup dockerd >/tmp/dockerd.log 2>&1 &       # a cloud session: Docker isn't running
pnpm install --frozen-lockfile
pnpm exec devcontainer up --workspace-folder . --config .devcontainer/cloud/devcontainer.json
pnpm exec devcontainer exec --workspace-folder . --config .devcontainer/cloud/devcontainer.json bash
```

Then, in the container:

```bash
pnpm db:start && pnpm db:reset && pnpm db:env
pnpm --dir apps/web build                     # builds the sim too, which seed.mjs runs
tools/load/matrix.sh                          # about 70 minutes; resumable
cd tools/load && uv run --locked python results.py report ../../docs/load/m3
```

## The files

- `matrix.sh`: every run in the spike's order, skipping any whose results exist; writes
  `machine.json`.
- `run.sh`: one run. It resets the database, starts `next start`, signs up and seeds the players,
  runs Locust headless (or `concurrency.py`), then the lost-update check, the server log's
  `UNSAFE_TRANSACTION` count and the Server-Timing histograms.
- `prepare.py`: anonymous sign-ups on the local stack's Auth, and the seed plan. Tokens stay in the
  work dir outside the repo (`LOAD_WORK`, default `~/load-work`), readable by its owner only.
- `seed.mjs`: writes each farm's backdated history through the admin database connection, built by
  the real rules (the API has no clock header and no seed route), and checks the log afterwards:
  each farm's seq rebuilt from its log must equal its seeded seq plus the actions the run saw
  accepted, with no gap, and every accepted key must sit at its answered seq. Node, through
  apps/web's own `@sunny-pastures/sim` and `postgres`, so it adds no dependency.
- `locustfile.py`: the player mix (80% active, a tap every 2–8 s, 15% looks; 20% returning after 8
  hours of backdating); `NO_WAIT=1` for the stress run. It logs each request's Server-Timing phases
  and loaded seq for `results.py`.
- `concurrency.py`: two harvests on one farm at the same moment, once per pair farm.
- `results.py`: `run` cuts a run's request log to the measured window into histograms; `report`
  pools the runs into `results.csv`.
- `test_locustfile.py`, `test_results.py`: the tap choice, the header parsing, the percentile and
  the cut of a run's request log (`uv run --locked python -m unittest -v`).
