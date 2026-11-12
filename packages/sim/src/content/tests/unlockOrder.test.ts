import { describe, expect, it } from "vitest";

import { draftSlice, findLevel, listFailures } from "./draft.js";

describe("R9 tierOrder", () => {
	it("rejects a tier unlocked before its facility (#189)", () => {
		const content = draftSlice();
		findLevel(content, 4).tiers = [];
		findLevel(content, 2).tiers.push({ facility: "bakery", tier: 2 });

		expect(listFailures(content)).toEqual([["tierOrder", "levels[1].tiers[0]"]]);
	});

	it("rejects tier 3 unlocked before tier 2 (#189)", () => {
		const content = draftSlice();
		findLevel(content, 3).tiers = [{ facility: "feedMill", tier: 3 }];
		findLevel(content, 5).tiers = [
			{ facility: "feedMill", tier: 2 },
			{ facility: "bakery", tier: 3 },
		];

		expect(listFailures(content)).toEqual([["tierOrder", "levels[2].tiers[0]"]]);
	});

	it("accepts a tier at its facility's Level, and tier 3 at tier 2's", () => {
		const content = draftSlice();
		findLevel(content, 3).tiers = [
			{ facility: "feedMill", tier: 2 },
			{ facility: "bakery", tier: 2 },
			{ facility: "bakery", tier: 3 },
		];
		findLevel(content, 4).tiers = [];
		findLevel(content, 5).tiers = [{ facility: "feedMill", tier: 3 }];

		expect(listFailures(content)).toEqual([]);
	});
});

describe("R10 addOnOrder", () => {
	it("rejects an add-on unlocked before any facility (#88)", () => {
		const content = draftSlice();
		findLevel(content, 4).addOns = [];
		findLevel(content, 1).addOns = ["collector"];

		expect(listFailures(content)).toEqual([["addOnOrder", "levels[0].addOns[0]"]]);
	});

	it("accepts an add-on at the first facility's Level", () => {
		const content = draftSlice();
		findLevel(content, 4).addOns = [];
		findLevel(content, 2).addOns = ["collector"];

		expect(listFailures(content)).toEqual([]);
	});
});
