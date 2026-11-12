import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import { mulberry32 } from "../../random/index.js";

describe("newFarm", () => {
	const sim = createSim(sliceContent);

	it("starts at time 0 with the content's coins, no XP, empty storage and plots, and no facilities", () => {
		const farm = sim.newFarm("farm-1");

		expect(farm.time).toBe(0);
		expect(farm.coins).toBe(sliceContent.start.coins);
		expect(farm.xp).toBe(0);
		expect(farm.silo).toEqual({});
		expect(farm.barn).toEqual({});
		expect(farm.facilities).toEqual([null, null]);
		expect(farm.plots).toHaveLength(sliceContent.start.plots);
		expect(farm.plots.every((plot) => plot.status === "empty")).toBe(true);
	});

	it("seeds its streams from the farm id (D9), and draws its first orders from the orders stream (#87)", () => {
		// The streamSeed vectors for farm-1, recorded from node:crypto in random/tests. Each of the
		// three wheat orders a Level 1 board opens with takes three draws: kinds, good and amount.
		const orders = Array.from({ length: 9 }).reduce<number>(
			(state) => mulberry32(state).next,
			0xe8550433,
		);
		expect(sim.newFarm("farm-1").streams).toEqual({ yields: 0x4e9eae85, orders });
	});

	it("is the same farm for the same id, and plain JSON", () => {
		const farm = sim.newFarm("farm-1");

		expect(createSim(sliceContent).newFarm("farm-1")).toEqual(farm);
		expect(JSON.parse(JSON.stringify(farm))).toEqual(farm);
	});
});
