import "server-only";

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import type { Config } from "@/server/config";

/**
 * The Drizzle client over postgres.js (#329 decision 2; #331 decision 9). The store takes it as an
 * argument and imports only this type, so `store` → type-only `db` holds (.fallowrc.jsonc).
 */
export type Db = PostgresJsDatabase & { $client: Sql };

/**
 * Builds the client from the config. postgres.js opens its pool on the first query, not here, so
 * building it touches no network. postgres.js 4.x leases a connection before it sends `BEGIN`, so
 * `db.transaction` can't hit 3.4's UNSAFE_TRANSACTION race (#327).
 */
export function createDb(config: Pick<Config, "databaseUrl">): Db {
	return drizzle(postgres(config.databaseUrl));
}
