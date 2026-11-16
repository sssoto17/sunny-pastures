# Local Supabase

A local Supabase stack (Postgres 17 plus the Supabase services) in Docker, for the persistence spike
and later M3. Only `config.toml` is tracked here.

Ports use the 553xx range (API 55321, DB 55322, Studio 55323, Mailpit 55324) instead of the CLI's
543xx default, so this stack can run beside another project's local Supabase.

## Requirements

- Docker running.
- Supabase CLI **2.122.0**, the standalone binary (e.g. `~/.local/bin/supabase`), not the npm
  package. Check it with `pnpm supabase:check`, which fails on any other version.

## Commands

Run them from the repo root (or a worktree's root).

| Task   | Command                     | Notes                                                             |
| ------ | --------------------------- | ----------------------------------------------------------------- |
| Start  | `pnpm db:start`             | First run pulls the images. Prints the URLs; every key is hidden. |
| Info   | `pnpm db:status`            | Same list again.                                                  |
| `.env` | `pnpm db:env`               | Writes `DATABASE_URL` to `./.env` without printing it.            |
| Stop   | `supabase stop`             | Keeps the data in Docker volumes.                                 |
| Reset  | `supabase db reset`         | Recreates the local database and reruns migrations and seed.      |
| Wipe   | `supabase stop --no-backup` | Stops and deletes the local data.                                 |

**Don't run `supabase start` or `supabase status` directly.** They print the local keys, S3
credentials and the database password on stdout _and_ stderr (even when piped), and terminal output
often gets pasted into a session. `supabase/db.sh` captures both streams and hides every value
except URLs, which keep the password hidden.

## Connection: `DATABASE_URL`

Code reads the connection string from `DATABASE_URL` only, never from a literal in the repo. Run
`pnpm db:env` in each worktree that needs it: it appends `DATABASE_URL` to `.env` (ignored by git)
unless one is already set. `.env.example` shows the shape.

Check it is reachable:

```bash
pg_isready -d "$DATABASE_URL"
```

Without a local `psql`/`pg_isready`, use the client inside the Supabase Postgres image that
`supabase start` already pulled:

```bash
docker run --rm --network host --entrypoint psql "$(docker inspect -f '{{.Config.Image}}' supabase_db_sunny-pastures)" "$DATABASE_URL" -c 'select version()'
```

## Claude Code sandbox

The CLI writes telemetry to `~/.supabase`, even for `supabase --version`. Inside the Claude Code
sandbox, home is read-only, so every `supabase` command fails with `EROFS`. Run Supabase commands
outside the sandbox, or with a writable `HOME` (e.g. `HOME=$TMPDIR supabase …`).
