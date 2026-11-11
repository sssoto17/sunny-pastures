import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { Content } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";
import { farmAt, xpOfLevel } from "./farmAt.js";

const sim = createSim(sliceContent);
const feedMill = 0;
const bakery = 1;

describe("buying a facility", () => {
	it("adds it at tier 1 with an empty queue for its price, once its Level unlocks it", () => {
		const farm = expectAccepted(
			sim.apply(farmAt(2, 50), { type: "buyFacility", facility: feedMill }, 0),
		);

		expect(farm.facilities).toEqual([{ tier: 1, jobs: [] }, null]);
		expect(farm.coins).toBe(20);
		expect(farm.xp).toBe(xpOfLevel(2));
	});

	it("buys the bakery at Level 3 for 50 coins", () => {
		const farm = expectAccepted(
			sim.apply(farmAt(3, 50), { type: "buyFacility", facility: bakery }, 0),
		);

		expect(farm.facilities).toEqual([null, { tier: 1, jobs: [] }]);
		expect(farm.coins).toBe(0);
	});

	it.each([
		[
			"before its Level",
			farmAt(2, 100),
			bakery,
			"The bakery isn't unlocked: it unlocks at Level 3, and you're at Level 2.",
		],
		[
			"with too few coins",
			farmAt(2, 29),
			feedMill,
			"The feedMill costs 30 coins, and the farm has 29.",
		],
		["for a facility not in content", farmAt(5, 100), 2, "There is no facility 3."],
		["for a negative index", farmAt(5, 100), -1, "There is no facility 0."],
	])("is refused %s", (_name, farm, facility, reason) => {
		expect(sim.apply(farm, { type: "buyFacility", facility }, 0)).toEqual({ ok: false, reason });
	});

	it("is refused for a facility the farm has, so an action sent twice buys it once", () => {
		const action = { type: "buyFacility", facility: feedMill } as const;
		const farm = expectAccepted(sim.apply(farmAt(2, 100), action, 0));

		expect(sim.apply(farm, action, 0)).toEqual({
			ok: false,
			reason: "The feedMill is already bought.",
		});
	});

	it("throws on a farm whose facilities don't match the content, a programmer error (D15)", () => {
		const broken = { ...farmAt(2, 100), facilities: [] };

		expect(() => sim.apply(broken, { type: "buyFacility", facility: feedMill }, 0)).toThrow(
			RangeError,
		);
	});

	it("is refused for a facility no Level unlocks", () => {
		const content: Content = {
			...sliceContent,
			levels: sliceContent.levels.map((level) => ({ ...level, facilities: [] })),
		};
		const locked = createSim(content);
		const farm = { ...locked.newFarm("farm-1"), xp: 1_000, coins: 1_000 };

		expect(locked.apply(farm, { type: "buyFacility", facility: feedMill }, 0)).toEqual({
			ok: false,
			reason: "The feedMill isn't unlocked at any Level.",
		});
	});
});
