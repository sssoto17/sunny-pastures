import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { Action, Content, FarmState } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";
import { farmAt, xpOfLevel } from "./farmAt.js";
import { ownedFacility } from "./ownedFacility.js";

const sim = createSim(sliceContent);
// The slice's recipes (#84): chicken feed takes 2 wheat and 60 s, bread 3 wheat and 300 s.
const feedMs = 60_000;
const breadMs = 300_000;

const feedMill = 0;
const bakery = 1;
const startFeed = { type: "startJob", facility: feedMill, recipe: "chickenFeed" } as const;
const startBread = { type: "startJob", facility: bakery, recipe: "bread" } as const;
const doneFeed = { status: "done", recipe: "chickenFeed" } as const;
const collectFeed = { type: "collect", facility: feedMill } as const;

/** A Level 3 farm with both facilities bought and `wheat` in the silo. */
const workshop = (wheat: number): FarmState => ({
	...farmAt(3, 0),
	silo: { wheat },
	facilities: [ownedFacility(), ownedFacility()],
});

/** Applies `actions` in turn, each at its time; fails the test on a refusal. */
const applyAll = (farm: FarmState, actions: readonly [Action, number][]): FarmState =>
	actions.reduce((current, [action, at]) => expectAccepted(sim.apply(current, action, at)), farm);

describe("starting a job", () => {
	it("takes the inputs from storage and stores when the job finishes and its recipe, for the Loop (MUST-03.2, 06.5, ADR-0006 §7)", () => {
		const farm = applyAll(workshop(5), [[startFeed, 1_000]]);

		expect(farm.silo).toEqual({ wheat: 3 });
		expect(farm.facilities[feedMill]).toEqual(
			ownedFacility([{ status: "running", recipe: "chickenFeed", readyAt: 1_000 + feedMs }], {
				lastRecipe: "chickenFeed",
			}),
		);
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

	it("is refused once the queue is full, and a job keeps its slot until collected (MUST-03.5)", () => {
		const full = applyAll(workshop(6), [
			[startFeed, 0],
			[startFeed, 0],
		]);

		expect(sim.apply(full, startFeed, 1_000_000)).toEqual({
			ok: false,
			reason: "The feedMill's queue is full: 2 of 2 slots.",
		});
		const collected = applyAll(full, [[collectFeed, 1_000_000]]);
		expect(sim.apply(collected, startFeed, 1_000_000).ok).toBe(true);
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
				facilities: [ownedFacility([doneFeed, doneFeed]), null],
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

describe("collecting", () => {
	it("moves the oldest job's goods to the barn and gives XP; the next job moves up (MUST-03.4)", () => {
		const farm = applyAll(workshop(4), [
			[startFeed, 0],
			[startFeed, 0],
			[collectFeed, feedMs],
		]);

		expect(farm.barn).toEqual({ chickenFeed: 2 });
		expect(farm.xp).toBe(xpOfLevel(3) + 1);
		expect(farm.facilities[feedMill]?.jobs).toEqual([
			{ status: "running", recipe: "chickenFeed", readyAt: 2 * feedMs },
		]);
	});

	it("pays the level-up coins of the Level its XP reaches (MUST-05.2, 05.4)", () => {
		const [, , , level4] = sliceContent.levels;
		const farm = applyAll({ ...workshop(3), xp: level4.xp - 2 }, [
			[startBread, 0],
			[{ type: "collect", facility: bakery }, breadMs],
		]);

		expect(farm.xp).toBe(level4.xp);
		expect(farm.coins).toBe(level4.coins);
		expect(farm.barn).toEqual({ bread: 1 });
	});

	it("throws on a done job whose recipe isn't in content, a programmer error (ADR-0006 §6)", () => {
		const stale = {
			...workshop(0),
			facilities: [ownedFacility([{ status: "done", recipe: "cake" }]), null],
		};

		expect(() => sim.apply(stale, collectFeed, 0)).toThrow(RangeError);
	});

	it.each([
		[
			"while the job is running",
			workshop(2),
			feedMs - 1,
			"The feedMill has no finished job to collect.",
		],
		["with no job", workshop(0), feedMs, "The feedMill has no finished job to collect."],
		[
			"if the barn can't hold the goods",
			{ ...workshop(2), barn: { bread: 49 } },
			feedMs,
			"The barn has room for 1 more good, and collecting the job needs room for 2 chickenFeed.",
		],
		[
			"for a facility not bought",
			{ ...workshop(2), facilities: [null, null] },
			feedMs,
			"The feedMill isn't bought.",
		],
	])("is refused %s (MUST-03.4)", (_name, farm, at, reason) => {
		const started =
			farm.silo["wheat"] === 2 && farm.facilities[feedMill] !== null
				? applyAll(farm, [[startFeed, 0]])
				: farm;

		expect(sim.apply(started, collectFeed, at)).toEqual({ ok: false, reason });
	});
});
