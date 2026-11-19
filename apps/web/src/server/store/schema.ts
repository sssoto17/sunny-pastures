// The B100 store's tables (#331, decisions 1, 3, 4 and 5; ADR-0001). The store owns its tables
// (#331 decision 9), and drizzle-kit generates the migrations from this file into
// supabase/migrations. No `server-only` here: drizzle-kit loads this file outside Next. What
// drizzle-kit can't express (the game_api role, its grants and the revokes) is in a custom
// migration beside the generated one.
import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	integer,
	jsonb,
	pgSchema,
	primaryKey,
	unique,
	uuid,
	type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { authUsers } from "drizzle-orm/supabase";

/**
 * Not in `[api].schemas` (supabase/config.toml), so PostgREST never exposes it; only the server
 * reaches it, as game_api (#331 decision 1).
 */
export const game = pgSchema("game");

/**
 * The action log, append-only by grant (game_api has `select` and `insert` only; ADR-0001, T10).
 * `seq` and `at` are `bigint` read as numbers: Drizzle converts with `Number()`, so the checks
 * refuse a value above 2^53 - 1 when it is written (#331 decision 4). `at` is server time in ms.
 * `rules_version` has no default, so a write that forgets to stamp it fails (ADR-0006).
 */
export const actions = game
	.table(
		"actions",
		{
			farmId: uuid("farm_id")
				.notNull()
				.references(() => authUsers.id, { onDelete: "cascade" }),
			seq: bigint("seq", { mode: "number" }).notNull(),
			at: bigint("at", { mode: "number" }).notNull(),
			action: jsonb("action").notNull(),
			idempotencyKey: uuid("idempotency_key").notNull(),
			answer: jsonb("answer").notNull(),
			rulesVersion: integer("rules_version").notNull(),
		},
		(table) => [
			primaryKey({ columns: [table.farmId, table.seq] }),
			unique("actions_farm_id_idempotency_key_unique").on(table.farmId, table.idempotencyKey),
			checkSafeInteger("actions_seq_check", table.seq, 1),
			checkSafeInteger("actions_at_check", table.at, 0),
			check("actions_rules_version_check", sql`${table.rulesVersion} > 0`),
		],
	)
	.enableRLS();

/**
 * A cache of the state at `seq`, keyed by rules version: at the same `seq` the higher version wins
 * (ADR-0006, section 5). Rebuildable from the log, so never the truth.
 */
export const snapshots = game
	.table(
		"snapshots",
		{
			farmId: uuid("farm_id")
				.notNull()
				.references(() => authUsers.id, { onDelete: "cascade" }),
			seq: bigint("seq", { mode: "number" }).notNull(),
			at: bigint("at", { mode: "number" }).notNull(),
			state: jsonb("state").notNull(),
			rulesVersion: integer("rules_version").notNull(),
		},
		(table) => [
			primaryKey({ columns: [table.farmId, table.seq, table.rulesVersion] }),
			checkSafeInteger("snapshots_seq_check", table.seq, 1),
			checkSafeInteger("snapshots_at_check", table.at, 0),
			check("snapshots_rules_version_check", sql`${table.rulesVersion} > 0`),
		],
	)
	.enableRLS();

/**
 * `column between min and 2^53 - 1`. Drizzle reads `bigint` with `Number()`, which silently loses
 * precision above 2^53 - 1, so the database refuses such a value when it's written (#331 decision 4).
 */
function checkSafeInteger(name: string, column: AnyPgColumn, min: 0 | 1) {
	return check(
		name,
		sql`${column} between ${sql.raw(String(min))} and ${sql.raw(String(Number.MAX_SAFE_INTEGER))}`,
	);
}
