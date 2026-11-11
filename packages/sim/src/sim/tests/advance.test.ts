import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import { plantWheat } from "./plantWheat.js";

const sim = createSim(sliceContent);

describe("advance", () => {
	it("returns the farm unchanged for a time before its own (D7)", () => {
		const farm = plantWheat(sim, "farm-1", 5_000);

		expect(sim.advance(farm, 4_999)).toBe(farm);
	});

	it("throws a RangeError on a time that isn't a safe integer (D7)", () => {
		expect(() => sim.advance(sim.newFarm("farm-1"), 2 ** 53)).toThrow(RangeError);
	});
});
