import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";
import { plantWheat } from "./plantWheat.js";

const sim = createSim(sliceContent);
const growMs = sliceContent.crops.wheat.growSeconds * 1000;
const { capacity } = sliceContent.silo;

describe("harvesting", () => {
	it("puts the base yield in the silo, empties the plot and gives XP (MUST-01.3)", () => {
		const farm = expectAccepted(
			sim.apply(plantWheat(sim, "farm-1"), { type: "harvest", plot: 0 }, growMs),
		);

		expect(farm.silo).toEqual({ wheat: 2 });
		expect(farm.plots[0]).toEqual({ status: "empty" });
		expect(farm.xp).toBe(1);
		// The yields stream moved one draw, and the orders stream none; farm-1's draw is above the
		// bonus threshold.
		expect(farm.streams).toEqual({
			yields: 3150588026,
			orders: sim.newFarm("farm-1").streams.orders,
		});
	});

	it("pays the level-up coins of the Level its XP reaches (MUST-05.4)", () => {
		const [, level2] = sliceContent.levels;
		const nearlyLevel2 = { ...plantWheat(sim, "farm-1"), xp: level2.xp - 1 };
		const farm = expectAccepted(sim.apply(nearlyLevel2, { type: "harvest", plot: 0 }, growMs));

		expect(farm.xp).toBe(level2.xp);
		expect(farm.coins).toBe(nearlyLevel2.coins + level2.coins);
	});

	it("adds the bonus when the yields stream's draw falls under the odds (MUST-01.4)", () => {
		const farm = expectAccepted(
			sim.apply(plantWheat(sim, "farm-15"), { type: "harvest", plot: 0 }, growMs),
		);

		expect(farm.silo).toEqual({ wheat: 3 });
		expect(farm.streams.yields).toBe(3121454511);
	});

	it("is refused before the crop is ready (MUST-01.2)", () => {
		expect(sim.apply(plantWheat(sim, "farm-1"), { type: "harvest", plot: 0 }, growMs - 1)).toEqual({
			ok: false,
			reason: "Plot 1 isn't ready to harvest.",
		});
	});

	it.each([
		["an empty plot", 1, "Plot 2 isn't ready to harvest."],
		["a plot that doesn't exist", -1, "There is no plot 0."],
	])("is refused on %s", (_name, plot, reason) => {
		expect(sim.apply(plantWheat(sim, "farm-1"), { type: "harvest", plot }, growMs)).toEqual({
			ok: false,
			reason,
		});
	});

	it("fills the silo to capacity when it has room for exactly the yield (MUST-01.3)", () => {
		// farm-1 draws no bonus, so its yield is 2.
		const room = { ...plantWheat(sim, "farm-1"), silo: { wheat: capacity - 2 } };
		const farm = expectAccepted(sim.apply(room, { type: "harvest", plot: 0 }, growMs));

		expect(farm.silo).toEqual({ wheat: capacity });
	});

	it("is refused if the silo can't hold the whole yield (MUST-01.3)", () => {
		const nearlyFull = { ...plantWheat(sim, "farm-1"), silo: { wheat: capacity - 1 } };

		expect(sim.apply(nearlyFull, { type: "harvest", plot: 0 }, growMs)).toEqual({
			ok: false,
			reason: "The silo has room for 1 more crop, and the harvest needs room for 2 wheat.",
		});
	});
});
