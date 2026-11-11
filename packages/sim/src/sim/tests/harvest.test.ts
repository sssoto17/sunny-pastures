import { describe, expect, it } from "vitest";

import { createSim, sliceContent, stateHash } from "../../index.js";
import type { FarmState } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";

const sim = createSim(sliceContent);
const growMs = sliceContent.crops.wheat.growSeconds * 1000;

/** A farm with wheat planted on plot 1 at `at`. */
function plantWheat(farmId: string, at = 0): FarmState {
	return expectAccepted(
		sim.apply(sim.newFarm(farmId), { type: "plant", plot: 0, crop: "wheat" }, at),
	);
}

describe("ripening", () => {
	it("happens exactly the grow time after planting, as an automated step (MUST-01.2)", () => {
		const farm = plantWheat("farm-1", 1_000);

		expect(sim.advance(farm, 1_000 + growMs - 1).plots[0]?.status).toBe("growing");
		expect(sim.advance(farm, 1_000 + growMs).plots[0]).toEqual({ status: "ready", crop: "wheat" });
	});

	it("survives times beyond 2^31 ms unchanged (D7, ADR-0003 section 10)", () => {
		const plantedAt = 2 ** 31 + 7;
		const to = 2 ** 33;
		const farm = sim.advance(plantWheat("farm-1", plantedAt), to);

		expect(farm.time).toBe(to);
		expect(farm.plots[0]).toEqual({ status: "ready", crop: "wheat" });
		expect(stateHash(farm)).toBe(stateHash(JSON.parse(JSON.stringify(farm))));
		expect(sim.advance(farm, to)).toBe(farm);
	});
});

describe("advance", () => {
	it("returns the farm unchanged for a time before its own (D7)", () => {
		const farm = plantWheat("farm-1", 5_000);

		expect(sim.advance(farm, 4_999)).toBe(farm);
	});

	it("throws a RangeError on a time that isn't a safe integer (D7)", () => {
		expect(() => sim.advance(sim.newFarm("farm-1"), 2 ** 53)).toThrow(RangeError);
	});
});

describe("harvesting", () => {
	it("puts the base yield in the silo, empties the plot and gives XP (MUST-01.3)", () => {
		const farm = expectAccepted(
			sim.apply(plantWheat("farm-1"), { type: "harvest", plot: 0 }, growMs),
		);

		expect(farm.silo).toEqual({ wheat: 2 });
		expect(farm.plots[0]).toEqual({ status: "empty" });
		expect(farm.xp).toBe(1);
		// The yields stream moved one draw; farm-1's draw is above the bonus threshold.
		expect(farm.streams).toEqual({ yields: 3150588026, orders: 0xe8550433 });
	});

	it("adds the bonus when the yields stream's draw falls under the odds (MUST-01.4)", () => {
		const farm = expectAccepted(
			sim.apply(plantWheat("farm-15"), { type: "harvest", plot: 0 }, growMs),
		);

		expect(farm.silo).toEqual({ wheat: 3 });
		expect(farm.streams.yields).toBe(3121454511);
	});

	it("is refused before the crop is ready (MUST-01.2)", () => {
		expect(sim.apply(plantWheat("farm-1"), { type: "harvest", plot: 0 }, growMs - 1)).toEqual({
			ok: false,
			reason: "Plot 1 isn't ready to harvest.",
		});
	});

	it.each([
		["an empty plot", 1, "Plot 2 isn't ready to harvest."],
		["a plot that doesn't exist", -1, "There is no plot 0."],
	])("is refused on %s", (_name, plot, reason) => {
		expect(sim.apply(plantWheat("farm-1"), { type: "harvest", plot }, growMs)).toEqual({
			ok: false,
			reason,
		});
	});

	it("is refused if the silo can't hold the whole yield (MUST-01.3)", () => {
		const nearlyFull = { ...plantWheat("farm-1"), silo: { wheat: sliceContent.silo.capacity - 1 } };

		expect(sim.apply(nearlyFull, { type: "harvest", plot: 0 }, growMs)).toEqual({
			ok: false,
			reason: "The silo has room for 1 more crop, and the harvest is 2 wheat.",
		});
	});
});
