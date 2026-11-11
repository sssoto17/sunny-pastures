import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { FarmState } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";

const sim = createSim(sliceContent);
const xpOfLevel = (level: number): number => sliceContent.levels[level - 1]?.xp ?? 0;

/** A new farm at `level` with `coins`. */
const farmAt = (level: number, coins: number): FarmState => ({
	...sim.newFarm("farm-1"),
	xp: xpOfLevel(level),
	coins,
});

/** Buys the next plot, `times` times; fails the test on a refusal. */
const buyPlots = (farm: FarmState, times: number): FarmState =>
	Array.from({ length: times }).reduce<FarmState>(
		(current) =>
			expectAccepted(sim.apply(current, { type: "buyPlot", plot: current.plots.length }, 0)),
		farm,
	);

describe("buying a plot", () => {
	it("adds an empty plot at the end for its price, once its Level unlocks it (MUST-06.1)", () => {
		const farm = expectAccepted(sim.apply(farmAt(2, 50), { type: "buyPlot", plot: 6 }, 0));

		expect(farm.plots).toHaveLength(7);
		expect(farm.plots[6]).toEqual({ status: "empty" });
		expect(farm.coins).toBe(30);
		expect(sim.apply(farm, { type: "plant", plot: 6, crop: "wheat" }, 0).ok).toBe(true);
	});

	it("costs more for each plot than the one before, up to 14 plots at Level 5 (MUST-06.1)", () => {
		const prices = [20, 30, 45, 67, 100, 150, 225, 337];
		let farm = farmAt(5, 10_000);
		for (const price of prices) {
			const next = buyPlots(farm, 1);
			expect(farm.coins - next.coins).toBe(price);
			farm = next;
		}

		expect(farm.plots).toHaveLength(14);
		expect(sim.apply(farm, { type: "buyPlot", plot: 14 }, 0)).toEqual({
			ok: false,
			reason: "The farm can't have more than 14 plots.",
		});
	});

	it.each([
		[
			"before its Level",
			farmAt(1, 50),
			6,
			"Plot 7 isn't unlocked: it unlocks at Level 2, and the farm is at Level 1.",
		],
		[
			"beyond what the farm's Level allows",
			buyPlots(farmAt(2, 50), 2),
			8,
			"Plot 9 isn't unlocked: it unlocks at Level 3, and the farm is at Level 2.",
		],
		["with too few coins", farmAt(2, 19), 6, "Plot 7 costs 20 coins, and the farm has 19."],
		["for a plot the farm has", farmAt(2, 50), 5, "The next plot to buy is plot 7."],
		["for a plot after the next", farmAt(2, 50), 7, "The next plot to buy is plot 7."],
	])("is refused %s", (_name, farm, plot, reason) => {
		expect(sim.apply(farm, { type: "buyPlot", plot }, 0)).toEqual({ ok: false, reason });
	});
});
