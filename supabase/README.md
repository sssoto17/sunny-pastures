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

<!-- prettier-ignore -->
| Task   | Command                     | Notes                                                                  |
| ------ | --------------------------- | ---------------------------------------------------------------------- |
| Start  | `pnpm db:start`             | First run pulls the images. Prints the URLs; every key is hidden.      |
| Info   | `pnpm db:status`            | Same list again.                                                       |
| `.env` | `pnpm db:env`               | Sets `game_api`'s password; writes `DATABASE_URL`, `ADMIN_DATABASE_URL`, `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` to `./.env` without printing them. |
| Stop   | `supabase stop`             | Keeps the data in Docker volumes.                                      |
| Reset  | `pnpm db:reset`             | `supabase db reset`: recreates the local database and reruns migrations and seed. Shows its output, redacted, only on failure. Then `pnpm db:env`. |
| Wipe   | `supabase stop --no-backup` | Stops and deletes the local data.                                      |

**Don't run `supabase start`, `supabase status` or `supabase db reset` directly.** The first two
print the local keys, S3 credentials and the database password on stdout _and_ stderr (even when
piped), and `db reset`'s output has shown a secret-shaped line too (#382). Terminal output often
gets pasted into a session. `supabase/db.sh` captures both streams and hides every value except
URLs, which keep the password hidden. `pnpm db:start` passes extra flags on to `supabase start`
(`pnpm db:start --exclude studio`).

## Migrations

The `game` schema's tables are Drizzle code in `apps/web/src/server/store/schema.ts` (#331, #372).
`pnpm db:generate` writes a migration for a change to it into `supabase/migrations/`, named the way
the Supabase CLI reads (`<timestamp>_<name>.sql`), beside drizzle-kit's `meta/` folder.
`pnpm db:reset` applies them. Grants, roles and anything else drizzle-kit can't express go in a
custom migration: `pnpm db:generate --custom --name <name>`, then write the SQL.

- **Forward-only.** Never edit, rename or delete a migration once it's on `main`; a fix is a new
  migration (CONSTRAINTS.md, "Migrations").
- **Atomic files.** No statement that commits on its own (`CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`,
  `CLUSTER`): `supabase db push` runs each file as one transaction (CONSTRAINTS.md, "Migrations:
  atomic files").
- **Expand/contract.** A migration works with the previous release's code: add in one release, drop
  or rename in a later one (CONSTRAINTS.md, "Checked by review").
- `pnpm db:check` (CI, `ci / lint`) fails on an edited migration, on a statement that commits on its
  own, and on drift: a `schema.ts` change with no migration. It needs no database.

## Tests against the stack: the `db` project

Tests that need the stack are `*.db.test.ts` files, Vitest's `db` project (vitest.config.mts; #382,
ADR-0007 section 6): grants, RLS, the transaction round trip, real anonymous sign-ups. `pnpm test`
runs them with the `unit` project in one coverage run, and `pnpm test --project db` runs them alone.
They need `pnpm db:start`, `pnpm db:reset` and `pnpm db:env` first. With no stack, the project's
global setup fails the run and says so; a `db` test never skips. Each test makes its own player with
`createPlayer` (`apps/web/src/server/db/tests/stack.ts`), so nothing is truncated. `ci / test`
starts a stack (`.github/actions/supabase-stack`) when a PR touches `apps/web/src/server/`,
`supabase/`, that action or `vitest.config.mts`, and on every push to `main`; other PRs run
`--project unit --project ui`.

**Without Docker** (a cloud lane, say), there is no stack, so `pnpm test` and `pnpm check:task` fail
whenever a `db` test is queued: `check:task` queues the `db` tests related to the change,
`pnpm test` all of them. A lane there that makes a change which queues a `db` test (in
`server/store/`, `server/auth/` or `server/db/`, say) runs `pnpm test --project unit --project ui`
locally, leaves the `db` tests to `ci / test`'s stack run, and says so in its PR.

## Connection: `DATABASE_URL`

Code reads the connection string from `DATABASE_URL` only, never from a literal in the repo. The app
connects as `game_api`, which may only read and append to the `game` tables. The migration creates
it with no password, so run `pnpm db:env` once after `pnpm db:reset`, then copy `.env` into other
worktrees: every worktree shares one local stack and one `game_api` password. It sets the password
(`alter role`, over `psql`'s stdin): the one in `.env`'s `game_api` `DATABASE_URL` if there is one,
otherwise a new random one. It writes `DATABASE_URL` (`game_api`) and `ADMIN_DATABASE_URL`
(`postgres`, for the `db` tests only) to `.env` (ignored by git), replacing earlier values. It
prints neither. `.env.example` shows the shape. It uses a local `psql` if there is one, or the one
in the stack's Postgres image.

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
