import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { Action, Content, FarmState } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";
import { farmAt, xpOfLevel } from "./farmAt.js";

const sim = createSim(sliceContent);
// The slice's recipes (#84): chicken feed takes 2 wheat and 60 s, bread 3 wheat and 300 s.
const feedMs = 60_000;
const breadMs = 300_000;

const feedMill = 0;
const bakery = 1;
const startFeed = { type: "startJob", facility: feedMill, recipe: "chickenFeed" } as const;
const startBread = { type: "startJob", facility: bakery, recipe: "bread" } as const;
const doneFeed = { status: "done", recipe: "chickenFeed" } as const;

/** A Level 3 farm with both facilities bought and `wheat` in the silo. */
const workshop = (wheat: number): FarmState => ({
	...farmAt(3, 0),
	silo: { wheat },
	facilities: [
		{ tier: 1, jobs: [] },
		{ tier: 1, jobs: [] },
	],
});

/** Applies `actions` in turn, each at its time; fails the test on a refusal. */
const applyAll = (farm: FarmState, actions: readonly [Action, number][]): FarmState =>
	actions.reduce((current, [action, at]) => expectAccepted(sim.apply(current, action, at)), farm);

describe("starting a job", () => {
	it("takes the inputs from storage and stores when the job finishes (MUST-03.2, ADR-0006 §7)", () => {
		const farm = applyAll(workshop(5), [[startFeed, 1_000]]);

		expect(farm.silo).toEqual({ wheat: 3 });
		expect(farm.facilities[feedMill]).toEqual({
			tier: 1,
			jobs: [{ status: "running", recipe: "chickenFeed", readyAt: 1_000 + feedMs }],
		});
		expect(farm.coins).toBe(0);
		expect(farm.xp).toBe(xpOfLevel(3));
	});

	it("queues a job behind a running one: it finishes the recipe's time after it (MUST-03.3)", () => {
		const farm = applyAll(workshop(4), [
			[startFeed, 0],
			[startFeed, 10_000],
		]);

		expect(farm.facilities[feedMill]?.jobs).toEqual([
			{ status: "running", recipe: "chickenFeed", readyAt: feedMs },
			{ status: "running", recipe: "chickenFeed", readyAt: 2 * feedMs },
		]);
	});

	it("runs from its start when the job before it has finished (MUST-03.3)", () => {
		const farm = applyAll(workshop(4), [
			[startFeed, 0],
			[startFeed, 100_000],
		]);

		expect(farm.facilities[feedMill]?.jobs).toEqual([
			{ status: "done", recipe: "chickenFeed" },
			{ status: "running", recipe: "chickenFeed", readyAt: 100_000 + feedMs },
		]);
	});

	it.each([
		[
			"for a facility not bought",
			{ ...workshop(5), facilities: [null, null] },
			startFeed,
			"The feedMill isn't bought.",
		],
		[
			"for a facility not in content",
			workshop(5),
			{ ...startFeed, facility: 2 },
			"There is no facility 3.",
		],
		[
			"for a recipe the facility lacks",
			workshop(5),
			{ ...startFeed, recipe: "bread" },
			"The feedMill has no recipe bread.",
		],
		[
			"without every input",
			workshop(2),
			startBread,
			"Making bread needs 3 wheat, and the silo has 2.",
		],
		[
			"once the queue is full, done jobs included (MUST-03.5)",
			{
				...workshop(5),
				facilities: [{ tier: 1, jobs: [doneFeed, doneFeed] }, null],
			},
			startFeed,
			"The feedMill's queue is full: 2 of 2 slots.",
		],
	])("is refused %s (MUST-03.2)", (_name, farm, action, reason) => {
		expect(sim.apply(farm, action, 0)).toEqual({ ok: false, reason });
	});

	it("is refused for a recipe above the facility's tier (MUST-03.2)", () => {
		const [mill, ...others] = sliceContent.facilities;
		const content: Content = {
			...sliceContent,
			facilities: [
				{
					...mill,
					recipes: { ...mill.recipes, cowFeed: { ...mill.recipes.chickenFeed, tier: 2 } },
				},
				...others,
			],
		};
		const tiered = createSim(content);

		expect(tiered.apply(workshop(5), { ...startFeed, recipe: "cowFeed" }, 0)).toEqual({
			ok: false,
			reason: "The feedMill makes cowFeed from tier 2, and it is at tier 1.",
		});
	});
});

describe("a job finishing", () => {
	it("is an automated step at the stored time, not a ms before (MUST-03.3)", () => {
		const farm = applyAll(workshop(3), [[startBread, 0]]);

		expect(sim.advance(farm, breadMs - 1).facilities[bakery]?.jobs).toEqual([
			{ status: "running", recipe: "bread", readyAt: breadMs },
		]);
		expect(sim.advance(farm, breadMs).facilities[bakery]?.jobs).toEqual([
			{ status: "done", recipe: "bread" },
		]);
	});

	it("keeps its stored time under a rules version with another duration (ADR-0006 §7, MUST-06.7)", () => {
		const farm = applyAll(workshop(3), [[startBread, 0]]);
		const [mill, oven] = sliceContent.facilities;
		const slower = createSim({
			...sliceContent,
			facilities: [mill, { ...oven, recipes: { bread: { ...oven.recipes.bread, seconds: 900 } } }],
		});

		expect(slower.advance(farm, breadMs).facilities[bakery]?.jobs).toEqual([
			{ status: "done", recipe: "bread" },
		]);
	});

	it("finishes beside a crop ripening at the same time, each step once (MUST-10.6)", () => {
		const farm = applyAll({ ...workshop(2), coins: 2 }, [
			[{ type: "plant", plot: 0, crop: "wheat" }, 0],
			[startFeed, feedMs],
		]);
		// Wheat grows in 120 s, so it ripens as the job started at 60 s finishes.
		const advanced = sim.advance(farm, 2 * feedMs);

		expect(advanced.plots[0]).toEqual({ status: "ready", crop: "wheat" });
		expect(advanced.facilities[feedMill]?.jobs).toEqual([
			{ status: "done", recipe: "chickenFeed" },
		]);
	});
});
