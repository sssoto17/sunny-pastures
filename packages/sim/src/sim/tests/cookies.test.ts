import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { FarmState } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";
import { farmAt, xpOfLevel } from "./farmAt.js";

const sim = createSim(sliceContent);
const bakery = 1;
// The slice's cookies (#85's "Decided by the lane", #72 D4): 2 wheat and 2 eggs make 1 cookies at
// bakery tier 2 for 5 XP, in 500 s at tier 1's rate, so 400 s at tier 2 and 300 s at tier 3.
const startCookies = { type: "startJob", facility: bakery, recipe: "cookies" } as const;

/** A Level 4 farm with the bakery at `tier`, wheat in the silo and eggs in the barn. */
const farmWithBakery = (tier: number, eggs: number): FarmState => ({
	...farmAt(4, 0),
	silo: { wheat: 10 },
	barn: { egg: eggs },
	facilities: [null, { tier, jobs: [] }],
});

describe("baking cookies", () => {
	it("is refused at bakery tier 1 (MUST-03.1, 03.2)", () => {
		expect(sim.apply(farmWithBakery(1, 4), startCookies, 0)).toEqual({
			ok: false,
			reason: "The bakery makes cookies from tier 2, and it is at tier 1.",
		});
	});

	it.each([
		[2, 400_000],
		[3, 300_000],
	])("takes 2 wheat and 2 eggs at tier %i and ends after %i ms (MUST-03.2, 03.3)", (tier, ms) => {
		const farm = expectAccepted(sim.apply(farmWithBakery(tier, 3), startCookies, 1_000));

		expect(farm.silo).toEqual({ wheat: 8 });
		expect(farm.barn).toEqual({ egg: 1 });
		expect(farm.facilities[bakery]?.jobs).toEqual([
			{ status: "running", recipe: "cookies", readyAt: 1_000 + ms },
		]);
	});

	it("is refused without 2 eggs in the barn", () => {
		expect(sim.apply(farmWithBakery(2, 1), startCookies, 0)).toEqual({
			ok: false,
			reason: "Making cookies needs 2 egg, and the barn has 1.",
		});
	});

	it("puts the cookies in the barn and gives 5 XP when collected (MUST-03.4)", () => {
		const started = expectAccepted(sim.apply(farmWithBakery(2, 2), startCookies, 0));
		const farm = expectAccepted(sim.apply(started, { type: "collect", facility: bakery }, 400_000));

		expect(farm.barn).toEqual({ cookies: 1 });
		expect(farm.facilities[bakery]?.jobs).toEqual([]);
		expect(farm.xp).toBe(xpOfLevel(4) + 5);
	});
});
