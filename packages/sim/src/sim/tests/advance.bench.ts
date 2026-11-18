// The sim speed row (CONSTRAINTS.md; ADR-0003, section 8), gating since #41: `pnpm bench` runs
// this in `check:task` and `ci / bench`. Each budget is judged as "Timing checks" requires: 3
// warm-up runs discarded, then the median of 5 measured runs; over budget, one full re-measure, and
// the check fails only if both medians are over.
//
// The largest farm is read from the content, never written here: every plot the Level table allows
// bought and planted, each ripening at a different time (#83); every facility at its highest tier
// with that tier's queue full of jobs (#84, #85); every pen bought with each animal producing and
// its trough full (#86); every order slot of the top Level discarded, so the whole board refills
// (#87); and every add-on on every facility with a full silo, so the Loops and Collectors run
// until the crops or the barn run out (#88, MUST-07.4).
import { expect, it } from "vitest";

import type { AddOn, Content } from "../../content/index.js";
import { createSim, sliceContent } from "../../index.js";
import type { Action, FarmState } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";

const content: Content = sliceContent;
const sim = createSim(content);
const thirtyDays = 30 * 24 * 60 * 60 * 1000;

/** Every good a list of goods asks for, in storage: crops in the silo, the rest in the barn. */
function stocked(farm: FarmState, goods: readonly { good: string; amount: number }[]): FarmState {
	return goods.reduce<FarmState>((current, { good, amount }) => {
		const store = good in content.crops ? "silo" : "barn";
		const held = current[store][good] ?? 0;
		return { ...current, [store]: { ...current[store], [good]: held + amount } };
	}, farm);
}

const topLevel = content.levels[content.levels.length - 1];
const crops = content.levels.flatMap((level) => level.crops);
const mostPlots = content.start.plots + content.levels.reduce((sum, level) => sum + level.plots, 0);
// As rich as a safe integer allows twice over, so no purchase or payout is refused for coins.
const rich: FarmState = {
	...sim.newFarm("bench"),
	xp: topLevel?.xp ?? 0,
	coins: Math.floor(Number.MAX_SAFE_INTEGER / 2),
};
const planted: FarmState = Array.from({ length: mostPlots }, (_plot, plot) => plot).reduce(
	(farm, plot) => {
		const owned =
			plot < farm.plots.length
				? farm
				: expectAccepted(sim.apply(farm, { type: "buyPlot", plot }, farm.time));
		const crop = crops[plot % crops.length] ?? "";
		return expectAccepted(sim.apply(owned, { type: "plant", plot, crop }, farm.time + 1_000));
	},
	rich,
);
const working: FarmState = content.facilities.reduce((farm, facility, index) => {
	const bought = facility.tiers.reduce(
		(current, _tier, i) =>
			expectAccepted(
				sim.apply(current, { type: "buyTier", facility: index, tier: i + 2 }, current.time),
			),
		expectAccepted(sim.apply(farm, { type: "buyFacility", facility: index }, farm.time)),
	);
	const { slots } = facility.tiers[facility.tiers.length - 1] ?? facility;
	const [[recipe, { inputs }] = ["", { inputs: [] }]] = Object.entries(facility.recipes);
	const start = { type: "startJob", facility: index, recipe } as const;
	return Array.from({ length: slots }).reduce<FarmState>(
		(current) => expectAccepted(sim.apply(stocked(current, inputs), start, current.time)),
		bought,
	);
}, planted);
const fed: FarmState = content.pens.reduce((farm, pen, index) => {
	const bought = expectAccepted(sim.apply(farm, { type: "buyPen", pen: index }, farm.time));
	return Array.from({ length: pen.animals + pen.troughCapacity }).reduce<FarmState>((current) => {
		const feed = stocked(current, [{ good: pen.feed, amount: 1 }]);
		return expectAccepted(sim.apply(feed, { type: "feed", pen: index }, current.time));
	}, bought);
}, working);
const fullFarm: FarmState = fed.board.reduce(
	(farm, _slot, slot) => expectAccepted(sim.apply(farm, { type: "discard", slot }, farm.time)),
	fed,
);
const addOns = Object.keys(content.addOns) as AddOn[];
/** Every add-on on every facility (MUST-07.4), and a full silo for the Loops to run on (#88). */
const automatedFarm: FarmState = {
	...content.facilities.reduce<FarmState>(
		(farm, _facility, facility) =>
			addOns.reduce(
				(current, addOn) =>
					expectAccepted(sim.apply(current, { type: "buyAddOn", facility, addOn }, current.time)),
				farm,
			),
		fullFarm,
	),
	silo: Object.fromEntries(
		crops.map((crop) => [crop, Math.floor(content.silo.capacity / crops.length)]),
	),
};

/**
 * The farm 30 days on, and one of every action on every plot, facility, pen and slot: each call
 * starts from the same farm, so about half are accepted (harvests, discards, a collect, the feeds)
 * and the rest take a refusal path (a plot already planted, too few goods, a full barn).
 */
const lateFarm = sim.advance(automatedFarm, automatedFarm.time + thirtyDays);
const everyAction: readonly Action[] = [
	...lateFarm.plots.flatMap((_plot, plot) => [
		{ type: "harvest", plot } as const,
		...crops.map((crop) => ({ type: "plant", plot, crop }) as const),
	]),
	...content.facilities.flatMap((facility, index) => [
		{ type: "collect", facility: index } as const,
		...Object.keys(facility.recipes).map(
			(recipe) => ({ type: "startJob", facility: index, recipe }) as const,
		),
	]),
	...content.pens.flatMap((_pen, pen) => [
		{ type: "feed", pen } as const,
		{ type: "collectProducts", pen } as const,
	]),
	...lateFarm.board.flatMap((_slot, slot) => [
		{ type: "deliver", slot } as const,
		{ type: "discard", slot } as const,
	]),
];
const rounds = Math.ceil(1_000 / everyAction.length);
const applyCalls = rounds * everyAction.length;

// The budgets, in ms (CONSTRAINTS.md, "Sim speed"), and the runs ("Timing checks").
const advanceBudget = 50;
const applyBudget = 1;
const runs = { warmupIterations: 3, warmupTime: 0, iterations: 5, time: 0 };

/**
 * The medians judged against a budget: one set of 5 runs, and a second only when the first is over
 * ("Timing checks", "Over budget"). The check passes when the smaller is within the budget.
 */
async function medians(measure: () => Promise<number>, budget: number): Promise<number[]> {
	const first = await measure();
	return first <= budget ? [first] : [first, await measure()];
}

it("advances 30 days and applies an action within the sim speed budget", async ({
	annotate,
	bench,
}) => {
	const advance = bench("advance 30 days on the largest farm", () => {
		sim.advance(automatedFarm, automatedFarm.time + thirtyDays);
	});
	const apply = bench(`apply ${String(applyCalls)} varied actions after 30 days`, () => {
		for (let round = 0; round < rounds; round += 1) {
			for (const action of everyAction) sim.apply(lateFarm, action, lateFarm.time);
		}
	});
	const advanceMs = await medians(async () => {
		const { latency } = await advance.run(runs);
		expect(latency.samplesCount).toBe(runs.iterations);
		return latency.p50;
	}, advanceBudget);
	const applyMs = await medians(async () => {
		const { latency } = await apply.run(runs);
		expect(latency.samplesCount).toBe(runs.iterations);
		return latency.p50 / applyCalls;
	}, applyBudget);

	const shown = (ms: number[]) => ms.map((m) => `${m.toFixed(3)} ms`).join(", then ");
	await annotate(
		`advance() 30 days, median of 5: ${shown(advanceMs)} (budget ${String(advanceBudget)} ms)`,
	);
	await annotate(
		`apply() per call, median of 5: ${shown(applyMs)} (budget ${String(applyBudget)} ms)`,
	);
	expect(Math.min(...advanceMs)).toBeLessThanOrEqual(advanceBudget);
	expect(Math.min(...applyMs)).toBeLessThanOrEqual(applyBudget);
});
