// The sim speed row (CONSTRAINTS.md; ADR-0003, section 8): advance across 30 days on the largest
// content farm, and one apply. Reported in the PR, not gating yet (#41). The largest farm is every
// plot the Level table allows bought (#83) and planted, each ripening at a different time, every
// facility bought with its queue full of jobs (#84), and every add-on on every facility with a
// full silo, so the Loops and Collectors run until the wheat runs out (#88, MUST-07.4).
import { expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { FarmState } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";

const sim = createSim(sliceContent);
const thirtyDays = 30 * 24 * 60 * 60 * 1000;

const topLevel = sliceContent.levels[sliceContent.levels.length - 1];
const mostPlots =
	sliceContent.start.plots + sliceContent.levels.reduce((sum, level) => sum + level.plots, 0);
const rich: FarmState = { ...sim.newFarm("bench"), xp: topLevel?.xp ?? 0, coins: 1_000_000 };
const planted: FarmState = Array.from({ length: mostPlots })
	.map((_plot, plot) => plot)
	.reduce<FarmState>((farm, plot) => {
		const owned =
			plot < farm.plots.length
				? farm
				: expectAccepted(sim.apply(farm, { type: "buyPlot", plot }, farm.time));
		const plant = { type: "plant", plot, crop: "wheat" } as const;
		return expectAccepted(sim.apply(owned, plant, farm.time + 1_000));
	}, rich);
const fullFarm: FarmState = sliceContent.facilities.reduce<FarmState>((farm, facility, index) => {
	const bought = expectAccepted(
		sim.apply(farm, { type: "buyFacility", facility: index }, farm.time),
	);
	const [recipe = ""] = Object.keys(facility.recipes);
	const start = { type: "startJob", facility: index, recipe } as const;
	return Array.from({ length: facility.slots }).reduce<FarmState>(
		(current) =>
			expectAccepted(sim.apply({ ...current, silo: { wheat: 10 } }, start, current.time)),
		bought,
	);
}, planted);
/** Every add-on on every facility (MUST-07.4), and a full silo for the Loops to run on (#88). */
const automatedFarm: FarmState = {
	...sliceContent.facilities.reduce<FarmState>(
		(farm, _facility, facility) =>
			(["collector", "loop"] as const).reduce(
				(current, addOn) =>
					expectAccepted(sim.apply(current, { type: "buyAddOn", facility, addOn }, current.time)),
				farm,
			),
		fullFarm,
	),
	silo: { wheat: sliceContent.silo.capacity },
};

// The budgets, in ms (CONSTRAINTS.md, "Sim speed"). Checked only when `vitest bench` runs.
const advanceBudget = 50;
const applyBudget = 1;

it("advances 30 days and applies an action within the sim speed budget", async ({
	bench: measure,
}) => {
	const results = await measure.compare(
		measure("advance 30 days, every plot planted, every queue full, every add-on", () => {
			sim.advance(automatedFarm, automatedFarm.time + thirtyDays);
		}),
		measure("apply one harvest after 30 days", () => {
			sim.apply(automatedFarm, { type: "harvest", plot: 0 }, automatedFarm.time + thirtyDays);
		}),
	);

	expect(
		results.get("advance 30 days, every plot planted, every queue full, every add-on").latency.mean,
	).toBeLessThan(advanceBudget);
	expect(results.get("apply one harvest after 30 days").latency.mean).toBeLessThan(applyBudget);
});
