import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { Action, Content, FarmState } from "../../index.js";
import { applyAll } from "./applyAll.js";
import { expectAccepted } from "./expectAccepted.js";
import { farmAt, xpOfLevel } from "./farmAt.js";
import { ownedFacility } from "./ownedFacility.js";
import { richContent } from "./richContent.js";

const sim = createSim(sliceContent);
const feedMill = 0;
const bakery = 1;
// The slice's tiers (#85's "Decided by the lane"), written out: the feed mill's tier 2 at Level 3
// for 60 coins and tier 3 at Level 5 for 120; the bakery's at Levels 4 and 5 for 100 and 200.
// Chicken feed takes 60 s at tier 1, 48 s at tier 2 and 36 s at tier 3; slots are 2, 3 and 3.
const feedMs = [60_000, 48_000, 36_000];
const startFeed = { type: "startJob", facility: feedMill, recipe: "chickenFeed" } as const;
const startBread = { type: "startJob", facility: bakery, recipe: "bread" } as const;
const buyTier = (facility: number, tier: number): Action => ({ type: "buyTier", facility, tier });

/** A farm at `level` with `coins`, both facilities bought at `tier`, and wheat in the silo. */
const farmWithFacilities = (level: number, coins: number, tier = 1): FarmState => ({
	...farmAt(level, coins),
	silo: { wheat: 40 },
	facilities: [ownedFacility([], { tier }), ownedFacility([], { tier })],
});

describe("buying a tier", () => {
	it("raises the facility one tier for its price, once its Level unlocks it (MUST-06.2)", () => {
		const farm = expectAccepted(sim.apply(farmWithFacilities(3, 70), buyTier(feedMill, 2), 0));

		expect(farm.facilities).toEqual([
			ownedFacility([], { tier: 2 }),
			ownedFacility([], { tier: 1 }),
		]);
		expect(farm.coins).toBe(10);
		expect(farm.xp).toBe(xpOfLevel(3));
		expect(farm.silo).toEqual({ wheat: 40 });
	});

	it("buys tier 3 after tier 2, and the bakery's tiers at their own Levels and prices", () => {
		const farm = applyAll(farmWithFacilities(5, 480), [
			[buyTier(feedMill, 2), 0],
			[buyTier(feedMill, 3), 0],
			[buyTier(bakery, 2), 0],
			[buyTier(bakery, 3), 0],
		]);

		expect(farm.facilities.map((owned) => owned?.tier)).toEqual([3, 3]);
		expect(farm.coins).toBe(0);
	});

	it.each([
		[
			"for a facility not in content",
			farmWithFacilities(5, 999),
			buyTier(2, 2),
			"There is no facility 3.",
		],
		["for a facility not bought", farmAt(5, 999), buyTier(bakery, 2), "The bakery isn't bought."],
		[
			"for the tier it is at, so an action sent twice buys it once",
			farmWithFacilities(5, 999, 2),
			buyTier(feedMill, 2),
			"The feedMill is already at tier 2.",
		],
		[
			"for tier 1",
			farmWithFacilities(5, 999),
			buyTier(feedMill, 1),
			"The feedMill is already at tier 1.",
		],
		[
			"for a tier past the next",
			farmWithFacilities(5, 999),
			buyTier(feedMill, 3),
			"The feedMill is at tier 1, so the next tier it can buy is 2.",
		],
		[
			"for a tier that isn't a whole number",
			farmWithFacilities(5, 999, 2),
			buyTier(feedMill, 2.5),
			"A tier is a whole number.",
		],
		[
			"past tier 3 (MUST-06.2)",
			farmWithFacilities(5, 999, 3),
			buyTier(feedMill, 4),
			"The feedMill has no tier 4: its highest is 3.",
		],
		[
			// Buying reads only the tier bought, never the stored one, so a broken farm's is refused.
			"past content's highest, from a stored tier content doesn't have",
			farmWithFacilities(5, 999, 4),
			buyTier(feedMill, 5),
			"The feedMill has no tier 5: its highest is 3.",
		],
		[
			"before its Level",
			farmWithFacilities(3, 999),
			buyTier(bakery, 2),
			"The bakery's tier 2 isn't unlocked: it unlocks at Level 4, and you're at Level 3.",
		],
		[
			"with too few coins",
			farmWithFacilities(3, 59),
			buyTier(feedMill, 2),
			"The feedMill's tier 2 costs 60 coins, and the farm has 59.",
		],
	])("is refused %s", (_name, farm, action, reason) => {
		expect(sim.apply(farm, action, 0)).toEqual({ ok: false, reason });
	});

	it("is refused for a tier no Level unlocks", () => {
		const locked: Content = {
			...sliceContent,
			levels: sliceContent.levels.map((level) => ({ ...level, tiers: [] })),
		};

		expect(createSim(locked).apply(farmWithFacilities(5, 999), buyTier(feedMill, 2), 0)).toEqual({
			ok: false,
			reason: "The feedMill's tier 2 isn't unlocked at any Level.",
		});
	});
});

describe("a facility's tier and its jobs", () => {
	it.each([1, 2, 3])("runs a job at tier %i for that tier's time (MUST-06.2, 03.3)", (tier) => {
		const farm = applyAll(farmWithFacilities(5, 0, tier), [[startFeed, 1_000]]);

		expect(farm.facilities[feedMill]?.jobs).toEqual([
			{ status: "running", recipe: "chickenFeed", readyAt: 1_000 + (feedMs[tier - 1] ?? NaN) },
		]);
	});

	// D16: 61 s doesn't divide by 800 or 600 per mille (48.8 s, 36.6 s), so a job time rounded to
	// the nearest second (49 s, 37 s) or not rounded at all fails here, as the slice's 60 s can't.
	it.each([
		[1, 61_000],
		[2, 48_000],
		[3, 36_000],
	])("rounds a job's time at tier %i down to whole seconds: %i ms (D16)", (tier, ms) => {
		const oddSim = createSim(richContent);
		const farm = expectAccepted(oddSim.apply(farmWithFacilities(5, 0, tier), startFeed, 1_000));

		expect(farm.facilities[feedMill]?.jobs).toEqual([
			{ status: "running", recipe: "chickenFeed", readyAt: 1_000 + ms },
		]);
	});

	// The slice's slots are 2, 3 and 3 at each facility (admin, 11 Nov).
	it.each([
		["feedMill", startFeed, 1, 2],
		["feedMill", startFeed, 2, 3],
		["feedMill", startFeed, 3, 3],
		["bakery", startBread, 1, 2],
		["bakery", startBread, 2, 3],
		["bakery", startBread, 3, 3],
	])("has the %s's slots at tier %i: %i (MUST-03.5, 06.2)", (id, start, tier, slots) => {
		const full = applyAll(
			farmWithFacilities(5, 0, tier),
			Array.from({ length: slots }, (): [Action, number] => [start, 0]),
		);

		expect(sim.apply(full, start, 0)).toEqual({
			ok: false,
			reason: `The ${id}'s queue is full: ${String(slots)} of ${String(slots)} slots.`,
		});
	});

	it("keeps the finish of every job queued or running when a tier is bought (MUST-03.3, 06.7)", () => {
		const queued = applyAll(farmWithFacilities(3, 60), [
			[startFeed, 0],
			[startFeed, 0],
			[buyTier(feedMill, 2), 10_000],
			[startFeed, 10_000],
		]);

		expect(queued.facilities[feedMill]?.jobs).toEqual([
			{ status: "running", recipe: "chickenFeed", readyAt: 60_000 },
			{ status: "running", recipe: "chickenFeed", readyAt: 120_000 },
			{ status: "running", recipe: "chickenFeed", readyAt: 120_000 + 48_000 },
		]);
	});

	it("throws on starting a job in a farm whose tier isn't in content: a broken farm, not a refusal", () => {
		expect(() => sim.apply(farmWithFacilities(5, 0, 4), startFeed, 0)).toThrow(RangeError);
	});
});
