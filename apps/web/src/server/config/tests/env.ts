import type { Env } from "../index";

/**
 * An environment holding `DATABASE_URL`. Environment names are UPPER_SNAKE, an outside shape the
 * naming rule doesn't allow as object keys, so the entry is built as a pair.
 */
export function makeEnv(databaseUrl: string): Env {
	return Object.fromEntries([["DATABASE_URL", databaseUrl]]);
}
