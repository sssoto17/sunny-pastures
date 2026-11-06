# Load harness (#10; the matrix runner is #15)

Locust 2.47.0 in its own uv project. `pyproject.toml` pins uv (`required-version`), Python 3.13
and Locust, and `exclude-newer` keeps out anything published less than 7 days before the lock
(the Python twin of pnpm's `minimumReleaseAge`).

In a cloud session, `. prototypes/persistence/cloud-setup.sh` does all of this (uv 0.13.6 from
PyPI, Python 3.13 via uv, `uv sync --locked`). Elsewhere:

```bash
python3 -m pip install uv==0.13.6     # or pipx; any way that gets exactly this version
```

```bash
cd prototypes/persistence/load && uv sync --locked
```

The matrix (every store × player count × run, resumable) is `src/matrix.ts`; see
`docs/spikes/persistence/matrix/README.md`. It calls `smoke.sh` once per configuration.

One run against one store: start the server with `SPIKE_CLOCK=1`, seed one farm per user, run
Locust headless, read the storage report, then stop the server:

```bash
prototypes/persistence/load/smoke.sh A
```

```bash
USERS=200 RUN_TIME=6m OUT=docs/spikes/persistence/<run> prototypes/persistence/load/smoke.sh B 100
```

```bash
cd prototypes/persistence/load && uv run --locked python summarize.py <run folder>...
```

- `locustfile.py`: 80% active players (a tap every 2–8 s; 15% of their taps are a GET whatever
  else they could do, #11), 20% returning players (+8 h of server time per return, through
  `X-Spike-Clock-Offset`; it only grows). `SPIKE_NO_WAIT=1` takes every wait out (the stress run).
- `results.py`: the matrix folder → `results.csv`, `chart.svg`, the Results table, the decision
  rule step by step and the stress runs (`uv run --locked python results.py`); its
  definitions are in its docstring.
- `test_locustfile.py`, `test_results.py`: the tap choice and the stress waits
  and the tail rebuild (`uv run --locked python -m unittest -v`). Moves are a registry;
  `SPIKE_ACTIONS` defaults to `plant,harvest,bake,collect` (#11). Gifts stay out of the mix.
- `WARMUP_S` (smoke.sh, then Locust) resets Locust's stats that many seconds in; `RUN_TIME`
  includes it. `window.json` records the measured window, and `summarize.py` cuts `server.csv`
  to it.
- `STORE_SCHEMA` (smoke.sh passes it through to the server) puts the run in its own schema.
- `server.csv` holds the same numbers as each response's `Server-Timing` (load, sim, commit, total).
- Storage reports cover the whole store schema, including earlier runs that used it: compare
  before and after, or give each run its own `STORE_SCHEMA` (the matrix does).
