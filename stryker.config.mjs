// Stryker (CONSTRAINTS.md, "Assertion strength (warn)"; #41): mutation score on the packages/sim
// source files a change touches. `ci / mutation` passes them with `--mutate`, so `mutate` here is
// only the fallback for a local run over the whole sim. The score never blocks: `break` is null,
// and the job turns a score under `low` (60%) into a warning annotation for the weekly retro.
/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
	testRunner: "vitest",
	// Only the tests that import a mutated file run against its mutants (Vitest's related mode).
	vitest: { configFile: "vitest.config.mts", related: true },
	coverageAnalysis: "perTest",
	mutate: ["packages/sim/src/**/*.ts", "!packages/sim/src/**/tests/**", "!**/*.test.ts"],
	thresholds: { high: 80, low: 60, break: null },
	reporters: ["clear-text", "json"],
	clearTextReporter: { reportTests: false },
	jsonReporter: { fileName: "reports/mutation/mutation.json" },
	// pnpm keeps each package's own node_modules, so Stryker can't find its runner by its default
	// `@stryker-mutator/*` glob; name it.
	plugins: ["@stryker-mutator/vitest-runner"],
	// Mutants go into the checkout itself, and Stryker puts each file back when it ends. A sandbox
	// copy fails on the symlinked folders in .claude/skills/ (EISDIR), and `ci / mutation` runs on a
	// throwaway checkout.
	inPlace: true,
};
