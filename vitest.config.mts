import { configDefaults, defineConfig } from "vitest/config";

// Coverage counts source files under apps/ and packages/ only (CONSTRAINTS.md, "What counts for
// coverage"). Widening `coverage.exclude` or narrowing `coverage.include` is a moved threshold.

// D10 (ADR-0003, section 9): property tests run with a fixed seed and a run count read from
// SIM_PROPERTY_RUNS: 100 when unset, 1000 in `ci / test`. Tests get both with inject('fastCheck'),
// so no test reads the environment itself. The repo has no @types/node, hence the declaration.
declare const process: { env: Record<string, string | undefined> };
const simPropertyRuns = Number(process.env["SIM_PROPERTY_RUNS"] ?? 100);
if (!Number.isSafeInteger(simPropertyRuns) || simPropertyRuns < 1) {
	throw new Error("SIM_PROPERTY_RUNS must be a positive integer");
}
// #200 (ADR-0003, section 9): a property's time grows with its run count, so its timeout does
// too: 15 ms per run, never below Vitest's 5 s default. Only the property test files apply it.
const propertyTimeout = Math.max(5_000, 15 * simPropertyRuns);

// apps/web's imports, resolved as Next resolves them (#342, #329 decisions 3 and 4): `@/` is its
// src/, and `server-only` is Next's own empty module on the server side, with no package to install.
// The sim is read from its source, never from a dist/ that may be stale or missing (#433): Next
// takes the built dist/, tests and coverage take src/. tsc reads src/ through the package's
// `@sunny-pastures/source` condition; Vite would need its default conditions repeated beside ours
// to do the same, so an exact alias keeps it to one line.
const fromRoot = (path: string) => decodeURIComponent(new URL(path, import.meta.url).pathname);

// Two projects in one coverage run (#382; ADR-0007 section 6, "The `db` project"), so
// coverage-gate.mjs still reads one lcov. `db` is every `*.db.test.ts`: it needs the local Supabase
// stack, and its global setup fails the run, naming `pnpm db:start`, when none answers. It never
// skips. `unit` is everything else. Both inherit this file's options (Vitest 5's inline projects
// extend the root), and arrays merge, so the include lists live in the projects, not at the root.
// `ci / test` picks `--project unit` when a PR can't reach the database (ci.yml).
const dbTests = "{apps,packages}/*/src/**/*.db.test.ts";

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@\//, replacement: fromRoot("apps/web/src/") },
			{ find: /^@sunny-pastures\/sim$/, replacement: fromRoot("packages/sim/src/index.ts") },
			{
				find: /^server-only$/,
				replacement: fromRoot("apps/web/node_modules/next/dist/compiled/server-only/empty.js"),
			},
		],
	},
	test: {
		provide: { fastCheck: { seed: 0x5eed, numRuns: simPropertyRuns }, propertyTimeout },
		projects: [
			{
				test: {
					name: "unit",
					include: [
						"{apps,packages}/*/src/**/*.{test,spec}.{ts,tsx}",
						".github/scripts/**/*.test.mjs",
					],
					exclude: [...configDefaults.exclude, dbTests],
				},
			},
			{
				test: {
					name: "db",
					include: [dbTests],
					globalSetup: ["apps/web/src/server/db/tests/stackSetup.ts"],
					// A round trip to the stack's Auth or Postgres takes longer than a unit test.
					testTimeout: 15_000,
					// The benchmarks are the unit project's: here they would run twice, and `ci / bench`
					// has no stack for this project's global setup.
					benchmark: { include: [] },
				},
			},
		],
		coverage: {
			provider: "v8",
			reporter: ["lcov", "text-summary"],
			reportsDirectory: "coverage",
			include: ["{apps,packages}/*/src/**/*.{ts,tsx}"],
			exclude: ["**/*.{test,spec}.{ts,tsx}", "**/tests/**", "**/*.d.ts", "**/generated/**"],
		},
	},
});
