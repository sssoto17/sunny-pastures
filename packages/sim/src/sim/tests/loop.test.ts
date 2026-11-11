import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { FarmState, Job } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";
import { farmAt, xpOfLevel } from "./farmAt.js";
import { ownedFacility } from "./ownedFacility.js";
import { bakery, breadMs, feedMill, feedMs, startFeed } from "./sliceJobs.js";

const sim = createSim(sliceContent);
const day = 24 * 60 * 60 * 1000;

const loop = { addOns: { loop: true, collector: false } } as const;
const both = { addOns: { loop: true, collector: true } } as const;
const running = (recipe: string, readyAt: number): Job => ({ status: "running", recipe, readyAt });

/** A Level 5 farm with `wheat`, `barn` and the feed mill as given; the bakery isn't bought. */
const looping = (
	wheat: number,
	mill = ownedFacility([], loop),
	barn: Record<string, number> = {},
): FarmState => ({
	...farmAt(5, 0),
	silo: { wheat },
	barn,
	facilities: [mill, null],
});

describe("the Loop", () => {
	it("starts the last recipe again into a free slot at the action's time, storing its finish (MUST-06.5, ADR-0006 §7)", () => {
		const farm = expectAccepted(sim.apply(looping(6), startFeed, 1_000));

		expect(farm.facilities[feedMill]?.jobs).toEqual([
			running("chickenFeed", 1_000 + feedMs),
			running("chickenFeed", 1_000 + 2 * feedMs),
		]);
		expect(farm.silo).toEqual({ wheat: 2 });
		// apply ran the restart due at its time, so advancing to that time changes nothing.
		expect(sim.advance(farm, 1_000)).toBe(farm);
	});

	it("stops when the inputs run out (MUST-06.5)", () => {
		const farm = expectAccepted(sim.apply(looping(3), startFeed, 0));
		const advanced = sim.advance(farm, day);

		expect(advanced.facilities[feedMill]?.jobs).toEqual([
			{ status: "done", recipe: "chickenFeed" },
		]);
		expect(advanced.silo).toEqual({ wheat: 1 });
	});

	it("stops when the slots are full: without a Collector, done jobs keep them (MUST-06.5, 03.5)", () => {
		const farm = expectAccepted(sim.apply(looping(40), startFeed, 0));
		const advanced = sim.advance(farm, day);

		expect(advanced.facilities[feedMill]?.jobs).toEqual([
			{ status: "done", recipe: "chickenFeed" },
			{ status: "done", recipe: "chickenFeed" },
		]);
		expect(advanced.silo).toEqual({ wheat: 36 });
	});

	it("runs with the Collector while the player is away, until the inputs run out (MUST-07.1)", () => {
		const farm = expectAccepted(sim.apply(looping(40, ownedFacility([], both)), startFeed, 0));
		const advanced = sim.advance(farm, day);

		// 20 jobs of 2 wheat, one a minute: the last moves at 20 minutes, 20 XP in all.
		expect(advanced.silo).toEqual({});
		expect(advanced.barn).toEqual({ chickenFeed: 40 });
		expect(advanced.facilities[feedMill]?.jobs).toEqual([]);
		expect(advanced.xp).toBe(xpOfLevel(5) + 20);
		expect(sim.advance(farm, 20 * feedMs - 1).barn).toEqual({ chickenFeed: 38 });
	});

	it("stops once its goods wouldn't fit, taking no inputs for goods that would wait (MUST-07.2)", () => {
		const mill = ownedFacility([], both);
		const farm = expectAccepted(sim.apply(looping(50, mill, { bread: 30 }), startFeed, 0));
		const advanced = sim.advance(farm, day);

		// Room for 20 goods, 10 feed jobs: the Loop starts a job only while the barn has room for its
		// feed and the queue's, so it stops at 10 jobs and keeps the rest of the wheat.
		expect(advanced.barn).toEqual({ bread: 30, chickenFeed: 20 });
		expect(advanced.silo).toEqual({ wheat: 30 });
		expect(advanced.facilities[feedMill]?.jobs).toEqual([]);
	});

	it("holds while goods wait for room, then resumes once the barn has room again (MUST-07.2)", () => {
		const waiting = ownedFacility([{ status: "done", recipe: "chickenFeed" }], {
			...both,
			lastRecipe: "chickenFeed",
		});
		const held = sim.advance(looping(10, waiting, { bread: 50 }), day);

		expect(held.facilities[feedMill]?.jobs).toEqual([{ status: "done", recipe: "chickenFeed" }]);
		expect(held.silo).toEqual({ wheat: 10 });

		// Room for 10 again (an order delivered, say): room for the waiting feed and a new job's.
		const resumed = sim.advance({ ...held, barn: { bread: 40 } }, day);
		expect(resumed.facilities[feedMill]?.jobs).toEqual([
			{ status: "done", recipe: "chickenFeed" },
			running("chickenFeed", day + feedMs),
		]);
		expect(resumed.silo).toEqual({ wheat: 8 });
		expect(sim.advance(resumed, day + feedMs).barn).toEqual({ bread: 40, chickenFeed: 4 });
	});

	it("keeps a restarted job's stored finish under a rules version with another duration (ADR-0006 §7, MUST-06.7)", () => {
		const farm = expectAccepted(sim.apply(looping(4), startFeed, 0));
		const [mill, oven] = sliceContent.facilities;
		const slower = createSim({
			...sliceContent,
			facilities: [
				{ ...mill, recipes: { chickenFeed: { ...mill.recipes.chickenFeed, seconds: 600 } } },
				oven,
			],
		});

		expect(slower.advance(farm, 2 * feedMs).facilities[feedMill]?.jobs).toEqual([
			{ status: "done", recipe: "chickenFeed" },
			{ status: "done", recipe: "chickenFeed" },
		]);
	});

	it("gives the last inputs to the lower facility index when two restart at the same ms (MUST-10.6)", () => {
		const farm: FarmState = {
			...looping(4),
			facilities: [
				ownedFacility([running("chickenFeed", breadMs), running("chickenFeed", breadMs + feedMs)], {
					...both,
					lastRecipe: "chickenFeed",
				}),
				ownedFacility([running("bread", breadMs), running("bread", 2 * breadMs)], {
					...both,
					lastRecipe: "bread",
				}),
			],
		};
		const advanced = sim.advance(farm, breadMs);

		expect(advanced.silo).toEqual({ wheat: 2 });
		expect(advanced.facilities[feedMill]?.jobs).toEqual([
			running("chickenFeed", breadMs + feedMs),
			running("chickenFeed", breadMs + 2 * feedMs),
		]);
		expect(advanced.facilities[bakery]?.jobs).toEqual([running("bread", 2 * breadMs)]);
	});

	it("starts as soon as it's bought, if a slot is free and the inputs are there (MUST-06.5)", () => {
		const idle = looping(2, ownedFacility([], { lastRecipe: "chickenFeed" }));
		const loopBought = { type: "buyAddOn", facility: feedMill, addOn: "loop" } as const;
		const farm = expectAccepted(sim.apply({ ...idle, coins: 80 }, loopBought, 5_000));

		expect(farm.facilities[feedMill]?.jobs).toEqual([running("chickenFeed", 5_000 + feedMs)]);
	});

	it("does nothing until a job has started, with no last recipe", () => {
		expect(sim.advance(looping(10), day).facilities[feedMill]?.jobs).toEqual([]);
	});
});
