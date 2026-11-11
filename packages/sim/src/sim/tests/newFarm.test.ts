import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";

describe("newFarm", () => {
	const sim = createSim(sliceContent);

	it("starts at time 0 with the content's coins, no XP, empty storage and empty plots", () => {
		const farm = sim.newFarm("farm-1");

		expect(farm.time).toBe(0);
		expect(farm.coins).toBe(sliceContent.start.coins);
		expect(farm.xp).toBe(0);
		expect(farm.silo).toEqual({});
		expect(farm.barn).toEqual({});
		expect(farm.plots).toHaveLength(sliceContent.start.plots);
		expect(farm.plots.every((plot) => plot.status === "empty")).toBe(true);
	});

	it("seeds its streams from the farm id (D9)", () => {
		// The streamSeed vectors for farm-1, recorded from node:crypto in random/tests.
		expect(sim.newFarm("farm-1").streams).toEqual({ yields: 0x4e9eae85, orders: 0xe8550433 });
	});

	it("is the same farm for the same id, and plain JSON", () => {
		const farm = sim.newFarm("farm-1");

		expect(createSim(sliceContent).newFarm("farm-1")).toEqual(farm);
		expect(JSON.parse(JSON.stringify(farm))).toEqual(farm);
	});
});
