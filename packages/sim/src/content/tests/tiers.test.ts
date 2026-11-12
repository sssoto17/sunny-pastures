import { describe, expect, it } from "vitest";

import { draftSlice, findFacility, findLevel, findRecipe, listFailures } from "./draft.js";

describe("R3 tierTime", () => {
	// 10 s is a timer at tier 1, but the feed mill's tiers make it 8 s and 6 s (#189).
	it("checks a recipe's job time at every tier that can make it, not only tier 1", () => {
		const content = draftSlice();
		findRecipe(content, "feedMill", "chickenFeed").seconds = 10;

		expect(listFailures(content)).toEqual([
			["tierTime", "facilities[0].recipes.chickenFeed.seconds"],
			["tierTime", "facilities[0].recipes.chickenFeed.seconds"],
		]);
	});

	it("accepts 17 s: rounded down, 13 s at tier 2 and 10 s at tier 3", () => {
		const content = draftSlice();
		findRecipe(content, "feedMill", "chickenFeed").seconds = 17;

		expect(listFailures(content)).toEqual([]);
	});

	// A 0 s recipe breaks advance (#88): its tier-1 time and every tier's are all 0 s.
	it("reports a 0 s recipe as a timer and as each tier's time", () => {
		const content = draftSlice();
		findRecipe(content, "bakery", "cookies").seconds = 0;

		expect(listFailures(content)).toEqual([
			["timer", "facilities[1].recipes.cookies.seconds"],
			["tierTime", "facilities[1].recipes.cookies.seconds"],
			["tierTime", "facilities[1].recipes.cookies.seconds"],
		]);
	});
});

describe("R17 tierSpeed", () => {
	it("rejects a tier that doesn't shorten jobs: timePerMille 1000 (MUST-06.2)", () => {
		const content = draftSlice();
		const [tier2] = findFacility(content, "feedMill").tiers;
		if (tier2 !== undefined) tier2.timePerMille = 1000;

		expect(listFailures(content)).toEqual([["tierSpeed", "facilities[0].tiers[0].timePerMille"]]);
	});

	it("rejects tier 3 no faster than tier 2 (#189)", () => {
		const content = draftSlice();
		const [, tier3] = findFacility(content, "feedMill").tiers;
		if (tier3 !== undefined) tier3.timePerMille = 800;

		expect(listFailures(content)).toEqual([["tierSpeed", "facilities[0].tiers[1].timePerMille"]]);
	});
});

describe("R18 tierSlots", () => {
	it.each([
		["two tiers in a row adding a slot, 2/3/4", [3, 4], "facilities[1].tiers[1].slots"],
		["a tier with fewer slots than the one below, 2/3/2", [3, 2], "facilities[1].tiers[1].slots"],
		["a tier adding two slots, 2/4/4", [4, 4], "facilities[1].tiers[0].slots"],
	])("rejects %s (MUST-06.2)", (_name, [tier2Slots, tier3Slots], path) => {
		const content = draftSlice();
		const [tier2, tier3] = findFacility(content, "bakery").tiers;
		if (tier2 !== undefined) tier2.slots = tier2Slots ?? 0;
		if (tier3 !== undefined) tier3.slots = tier3Slots ?? 0;

		expect(listFailures(content)).toEqual([["tierSlots", path]]);
	});

	it("rejects a facility with no slot at tier 1 (MUST-03.5)", () => {
		const content = draftSlice();
		const bakery = findFacility(content, "bakery");
		bakery.slots = 0;
		bakery.tiers = bakery.tiers.map((tier) => ({ ...tier, slots: 1 }));

		expect(listFailures(content)).toEqual([["tierSlots", "facilities[1].slots"]]);
	});

	it("accepts the slot added at tier 3 instead, 2/2/3", () => {
		const content = draftSlice();
		const [tier2] = findFacility(content, "bakery").tiers;
		if (tier2 !== undefined) tier2.slots = 2;

		expect(listFailures(content)).toEqual([]);
	});
});

describe("R19 tierCount", () => {
	it("rejects a tier-4 row, which is SHOULD-08 (MUST-06.2)", () => {
		const content = draftSlice();
		findFacility(content, "feedMill").tiers.push({
			price: 240,
			slots: 4,
			timePerMille: 400,
		});
		findLevel(content, 5).tiers.push({ facility: "feedMill", tier: 4 });

		expect(listFailures(content)).toEqual([["tierCount", "facilities[0].tiers.length"]]);
	});

	it.each([0, 4])("rejects a recipe at tier %s, outside the facility's tiers", (tier) => {
		const content = draftSlice();
		findFacility(content, "feedMill").recipes["mash"] = {
			tier,
			inputs: [{ good: "wheat", amount: 1 }],
			output: { good: "mash", amount: 1 },
			seconds: 60,
			xp: 1,
		};

		expect(listFailures(content)).toEqual([["tierCount", "facilities[0].recipes.mash.tier"]]);
	});
});

describe("R20 tierPrice", () => {
	it("rejects a free tier (#189)", () => {
		const content = draftSlice();
		const [, tier3] = findFacility(content, "bakery").tiers;
		if (tier3 !== undefined) tier3.price = 0;

		expect(listFailures(content)).toEqual([["tierPrice", "facilities[1].tiers[1].price"]]);
	});
});
