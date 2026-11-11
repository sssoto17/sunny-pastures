// The sim speed row (CONSTRAINTS.md; ADR-0003, section 8): advance across 30 days on the largest
// content farm, and one apply. Reported in the PR, not gating yet (#41). With wheat the only
// content, the largest farm is every plot planted, each ripening at a different time.
import { expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { FarmState } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";

const sim = createSim(sliceContent);
const thirtyDays = 30 * 24 * 60 * 60 * 1000;

const fullFarm: FarmState = Array.from({ length: sliceContent.start.plots }).reduce<FarmState>(
	(farm, _plot, plot) =>
		expectAccepted(sim.apply(farm, { type: "plant", plot, crop: "wheat" }, farm.time + 1_000)),
	sim.newFarm("bench"),
);

// The budgets, in ms (CONSTRAINTS.md, "Sim speed"). Checked only when `vitest bench` runs.
const advanceBudget = 50;
const applyBudget = 1;

it("advances 30 days and applies an action within the sim speed budget", async ({
	bench: measure,
}) => {
	const results = await measure.compare(
		measure("advance 30 days, every plot planted", () => {
			sim.advance(fullFarm, fullFarm.time + thirtyDays);
		}),
		measure("apply one harvest after 30 days", () => {
			sim.apply(fullFarm, { type: "harvest", plot: 0 }, fullFarm.time + thirtyDays);
		}),
	);

	expect(results.get("advance 30 days, every plot planted").latency.mean).toBeLessThan(
		advanceBudget,
	);
	expect(results.get("apply one harvest after 30 days").latency.mean).toBeLessThan(applyBudget);
});
