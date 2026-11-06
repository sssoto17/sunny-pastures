# Smoke run (#10): proves the harness, not the stores

1 min at 50 users (40 active, 10 returning) against A and B25, each player seeded with about
1,000 actions. Run in a cloud container (4 vCPU, 15 GB, Postgres 16 from apt, no Supabase),
which **is not the matrix machine (#15)**. These numbers show that the harness runs and that
its two sources agree. They are not results and don't feed ADR-0001's decision rule.

Per store folder: `locust.json` (final Locust stats), `locust_*.csv`, `server.csv` (one row per
response, the same numbers as `Server-Timing`), `seed.json`, `storage-before.json` and
`storage-after.json`. Summarise with `prototypes/persistence/load/summarize.py`.
