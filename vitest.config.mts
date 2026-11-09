import { defineConfig } from 'vitest/config';

// Coverage counts source files under apps/ and packages/ only (CONSTRAINTS.md, "What counts for
// coverage"). Widening `coverage.exclude` or narrowing `coverage.include` is a moved threshold.

// D10 (ADR-0003, section 9): property tests run with a fixed seed and a run count read from
// SIM_PROPERTY_RUNS: 100 when unset, 1000 in `ci / test`. Tests get both with inject('fastCheck'),
// so no test reads the environment itself. The repo has no @types/node, hence the declaration.
declare const process: { env: Record<string, string | undefined> };
const simPropertyRuns = Number(process.env['SIM_PROPERTY_RUNS'] ?? 100);
if (!Number.isSafeInteger(simPropertyRuns) || simPropertyRuns < 1) {
  throw new Error('SIM_PROPERTY_RUNS must be a positive integer');
}

export default defineConfig({
  test: {
    provide: { fastCheck: { seed: 0x5eed, numRuns: simPropertyRuns } },
    include: ['{apps,packages}/*/src/**/*.{test,spec}.{ts,tsx}', '.github/scripts/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text-summary'],
      reportsDirectory: 'coverage',
      include: ['{apps,packages}/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.{test,spec}.{ts,tsx}', '**/tests/**', '**/*.d.ts', '**/generated/**'],
    },
  },
});
