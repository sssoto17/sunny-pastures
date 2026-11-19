-- The game_api role and the game schema's grants (#331 decision 2; #372). drizzle-kit can't express
-- these, so this is a custom migration (`drizzle-kit generate --custom`). Forward-only: once applied,
-- never edit it; a fix is a new migration (CONSTRAINTS.md).
--
-- game_api is the role the app connects as. It logs in, but the migration sets no password: a
-- committed password is a committed secret. Locally, `pnpm db:env` sets a random one; hosted roles
-- are #64. Roles are cluster-wide and can outlive a database reset, so it's created only if missing,
-- and its attributes are set either way.
DO $$
BEGIN
	IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'game_api') THEN
		CREATE ROLE game_api WITH LOGIN;
	END IF;
END
$$;
--> statement-breakpoint
-- BYPASSRLS: RLS is on with no policies (#331 decision 2), which refuses every row to a role that
-- doesn't bypass it, game_api included. The grants below are what limit game_api: select and insert
-- on two tables, so the log is append-only by grant (ADR-0001, T10). SUPERUSER and REPLICATION
-- are left at their defaults (off): a role without them may not name them, even to turn them off.
ALTER ROLE game_api WITH LOGIN NOCREATEDB NOCREATEROLE BYPASSRLS NOINHERIT;
--> statement-breakpoint
-- PostgREST's roles and everyone else get nothing in game, as a second layer beside the schema not
-- being exposed and RLS having no policies.
REVOKE ALL ON SCHEMA game FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA game FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT USAGE ON SCHEMA game TO game_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON game.actions, game.snapshots TO game_api;
