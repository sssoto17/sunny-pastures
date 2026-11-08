import { defineConfig } from 'vitest/config';

// Coverage counts source files under apps/ and packages/ only (CONSTRAINTS.md, "What counts for
// coverage"). Widening `coverage.exclude` or narrowing `coverage.include` is a moved threshold.
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.{test,spec}.{ts,tsx}', '.github/scripts/**/*.test.mjs'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text-summary'],
      reportsDirectory: 'coverage',
      include: ['{apps,packages}/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.{test,spec}.{ts,tsx}', '**/*.d.ts', '**/generated/**'],
    },
  },
});
