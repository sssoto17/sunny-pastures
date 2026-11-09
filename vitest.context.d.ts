// The values vitest.config.mts provides to tests through Vitest's provide/inject.
import "vitest";

declare module "vitest" {
	export interface ProvidedContext {
		/** fast-check's fixed seed and run count for property tests (D10, ADR-0003 section 9). */
		fastCheck: { seed: number; numRuns: number };
	}
}
