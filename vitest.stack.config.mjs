import { defineConfig } from "vitest/config";

import base from "./vitest.config.mts";

// The tests that need the local Supabase stack (#372): `pnpm test:stack:db`, after `pnpm db:start`,
// `supabase db reset` and `pnpm db:env`. They're `*.stack.ts` files in a module's `tests/` folder,
// outside `pnpm test`'s `*.test.ts` glob, so the unit run needs no database and nothing is
// skipped. Without the variables this run fails and says why. CI runs it once #49 adds a stack.
// Both URLs come from `.env` (written by `pnpm db:env`) or the environment, and are handed to the
// tests through provide/inject, so no test reads the environment itself.
// vitest.config.stack.mjs (`pnpm test:stack`, #371) runs the auth module's `*.stack-test.ts` the
// same way; #382 merges the two into one `db` project.
// `pnpm test:stack:db` loads `.env` with Node's `--env-file-if-exists`. JavaScript, not TypeScript,
// so it lints as the other tool scripts do (eslint.config.mjs).

const databaseUrl = process.env["DATABASE_URL"];
const adminDatabaseUrl = process.env["ADMIN_DATABASE_URL"];
if (!databaseUrl || !adminDatabaseUrl) {
	throw new Error(
		"pnpm test:stack:db needs DATABASE_URL (game_api) and ADMIN_DATABASE_URL (postgres): run pnpm db:start, supabase db reset, then pnpm db:env.",
	);
}

// Spread, not mergeConfig: mergeConfig concatenates arrays, which would keep the unit tests in.
export default defineConfig({
	...base,
	test: {
		...base.test,
		provide: { ...base.test?.provide, stack: { databaseUrl, adminDatabaseUrl } },
		include: ["apps/*/src/**/tests/*.stack.ts"],
		fileParallelism: false,
		coverage: { enabled: false },
	},
});
