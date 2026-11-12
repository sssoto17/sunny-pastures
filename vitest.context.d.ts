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
	}
}
