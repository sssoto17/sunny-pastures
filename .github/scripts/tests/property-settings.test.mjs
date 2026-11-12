// The fast-check settings every property gets (D10, ADR-0003 section 9), as the root
// vitest.config.mts provides them: SIM_PROPERTY_RUNS runs, 100 when it's unset, and the fixed seed.
// A count cut in the config another way (`* 0 + 1`, another variable or env name) fails here
// (#133's known limits, #135); the floor guard watches the literals on this file's lines.
import { describe, expect, inject, it } from "vitest";

describe("the root config's fast-check settings", () => {
	it("run SIM_PROPERTY_RUNS times, at least 100, with the fixed seed", () => {
		const runs = Number(process.env.SIM_PROPERTY_RUNS ?? 100);
		const settings = inject("fastCheck");

		expect(settings.numRuns).toBe(runs);
		expect(runs).toBeGreaterThanOrEqual(100);
		expect(settings.seed).toBe(0x5eed);
	});
});
