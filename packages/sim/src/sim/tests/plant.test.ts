import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";

const sim = createSim(sliceContent);
const { wheat } = sliceContent.crops;

describe("planting", () => {
	it("costs the seed price and grows until exactly its grow time after planting (MUST-01.1, 01.2)", () => {
		const farm = expectAccepted(
			sim.apply(sim.newFarm("farm-1"), { type: "plant", plot: 2, crop: "wheat" }, 5_000),
		);

		expect(farm.time).toBe(5_000);
		expect(farm.coins).toBe(48);
		expect(farm.plots[2]).toEqual({ status: "growing", crop: "wheat", readyAt: 125_000 });
	});

	it.each([
		["the plot isn't empty", { plot: 0, crop: "wheat" }, "Plot 1 isn't empty."],
		["the plot doesn't exist", { plot: 6, crop: "wheat" }, "There is no plot 7."],
		["the plot isn't a whole number", { plot: 0.5, crop: "wheat" }, "There is no plot 1.5."],
		["the crop isn't in the content", { plot: 1, crop: "toString" }, "There is no crop toString."],
	])("is refused if %s", (_name, target, reason) => {
		const farm = expectAccepted(
			sim.apply(sim.newFarm("farm-1"), { type: "plant", plot: 0, crop: "wheat" }, 0),
		);

		expect(sim.apply(farm, { type: "plant", ...target }, 0)).toEqual({ ok: false, reason });
	});

	it("is refused if the farm has too few coins (MUST-01.1)", () => {
		const poor = { ...sim.newFarm("farm-1"), coins: wheat.seedPrice - 1 };

		expect(sim.apply(poor, { type: "plant", plot: 0, crop: "wheat" }, 0)).toEqual({
			ok: false,
			reason: "Planting wheat costs 2 coins, and the farm has 1.",
		});
	});

	it("is refused at a time before the farm's (D7, MUST-14.7)", () => {
		const farm = expectAccepted(
			sim.apply(sim.newFarm("farm-1"), { type: "plant", plot: 0, crop: "wheat" }, 1_000),
		);

		expect(sim.apply(farm, { type: "plant", plot: 1, crop: "wheat" }, 999)).toEqual({
			ok: false,
			reason: "The action is at 999 ms, before the farm's time of 1000 ms.",
		});
	});

	it("throws a RangeError if the crop would be ready past the largest safe time (D7, D16)", () => {
		const late = { ...sim.newFarm("farm-1"), time: Number.MAX_SAFE_INTEGER - 1 };

		expect(() => sim.apply(late, { type: "plant", plot: 0, crop: "wheat" }, late.time)).toThrow(
			RangeError,
		);
	});

	it.each([0.5, NaN, 2 ** 53, -Infinity])(
		"throws on a time that isn't a safe integer: %s (D7)",
		(at) => {
			expect(() =>
				sim.apply(sim.newFarm("farm-1"), { type: "plant", plot: 0, crop: "wheat" }, at),
			).toThrow(RangeError);
		},
	);
});
