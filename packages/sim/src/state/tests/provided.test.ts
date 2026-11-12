// #213: without the root vitest.config.mts (Vitest run from packages/sim), inject() gives
// undefined, and fast-check given no settings picks a random seed. The guard throws instead.
import { describe, expect, it } from "vitest";

import { requireProvided } from "./provided.js";

describe("requireProvided", () => {
	it("returns the value the root Vitest config provided", () => {
		const settings = { seed: 24_301, numRuns: 100 };

		expect(requireProvided("fastCheck", settings)).toBe(settings);
	});

	it("throws, naming the key and the root config, when Vitest provided nothing", () => {
		expect(() => requireProvided("fastCheck", undefined)).toThrow(/fastCheck.*vitest\.config\.mts/);
	});
});
