import { defineConfig } from "vitest/config";

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
const fromRoot = (path: string) => decodeURIComponent(new URL(path, import.meta.url).pathname);

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@\//, replacement: fromRoot("apps/web/src/") },
			{
				find: /^server-only$/,
				replacement: fromRoot("apps/web/node_modules/next/dist/compiled/server-only/empty.js"),
			},
		],
	},
	test: {
		provide: { fastCheck: { seed: 0x5eed, numRuns: simPropertyRuns }, propertyTimeout },
		include: ["{apps,packages}/*/src/**/*.{test,spec}.{ts,tsx}", ".github/scripts/**/*.test.mjs"],
		coverage: {
			provider: "v8",
			reporter: ["lcov", "text-summary"],
			reportsDirectory: "coverage",
			include: ["{apps,packages}/*/src/**/*.{ts,tsx}"],
			exclude: ["**/*.{test,spec}.{ts,tsx}", "**/tests/**", "**/*.d.ts", "**/generated/**"],
		},
	},
});
