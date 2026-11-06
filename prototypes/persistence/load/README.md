# Load harness (#10)

Locust 2.47.0 in its own uv project. `pyproject.toml` pins uv (`required-version`), Python 3.13
and Locust, and `exclude-newer` keeps out anything published less than 7 days before the lock
(the Python twin of pnpm's `minimumReleaseAge`).

```bash
python3 -m pip install uv==0.13.6     # or pipx; any way that gets exactly this version
cd prototypes/persistence/load && uv sync --locked
```

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

- `locustfile.py`: 80% active players (a tap every 2–8 s), 20% returning players (+8 h of
  server time per return, through `X-Spike-Clock-Offset`; it only grows). Moves are a registry:
  `SPIKE_ACTIONS=plant,harvest` until #8, then add bake, collect and gift moves there.
- `server.csv` holds the same numbers as each response's `Server-Timing` (load, sim, commit, total).
- Storage reports cover the whole store schema, including earlier runs: compare before and after.
