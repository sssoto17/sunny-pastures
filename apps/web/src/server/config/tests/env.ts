import type { Env } from "../index";

/** The Supabase settings the tests use unless they pass their own. */
export const testSupabase = {
	url: "http://supabase.test",
	publishableKey: "publishable-key-for-tests",
};

/**
 * An environment holding every variable the config reads. Environment names are UPPER_SNAKE, an
 * outside shape the naming rule doesn't allow as object keys, so the entries are built as pairs.
 */
export function makeEnv(databaseUrl: string, supabase = testSupabase): Env {
	return Object.fromEntries([
		["DATABASE_URL", databaseUrl],
		["SUPABASE_URL", supabase.url],
		["SUPABASE_PUBLISHABLE_KEY", supabase.publishableKey],
	]);
}
