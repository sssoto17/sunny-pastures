// The values vitest.config.mts provides to tests through Vitest's provide/inject.
import "vitest";

declare module "vitest" {
	export interface ProvidedContext {
		/** fast-check's fixed seed and run count for property tests (D10, ADR-0003 section 9). */
		fastCheck: { seed: number; numRuns: number };
		/**
		 * The per-test timeout in ms for property test files, scaled with the run count (#200). Each
		 * file applies it with `vi.setConfig`, which Vitest resets after the file.
		 */
		propertyTimeout: number;
		/**
		 * The local stack's settings, provided only to the `db` project's `*.db.test.ts` files by its
		 * global setup (apps/web/src/server/tests/setup.ts; ADR-0007 section 6): game_api's
		 * connection string, postgres's for setting up and acting as other roles, and the Supabase
		 * API's URL and publishable key. All four are secrets in output: never print them.
		 */
		stack?: {
			databaseUrl: string;
			adminDatabaseUrl: string;
			supabaseUrl: string;
			supabasePublishableKey: string;
		};
	}
}
