import { describe, expect, it } from "vitest";

import { draftSlice, findLevel, findOrderGood, findPen, listFailures } from "./draft.js";

describe("R32 uniqueIds", () => {
	it("rejects a second order-good entry for a good", () => {
		const content = draftSlice();
		content.orderGoods.push({ ...findOrderGood(content, "egg") });

		expect(listFailures(content)).toEqual([["uniqueIds", "orderGoods[4]"]]);
	});

	it("rejects a second pen with a pen's id", () => {
		const content = draftSlice();
		content.pens.push({ ...findPen(content, "chickenPen") });

		expect(listFailures(content)).toEqual([["uniqueIds", "pens[1]"]]);
	});
});

describe("R4 unlockExists", () => {
	it("rejects a Level listing a crop content doesn't have (MUST-10.4)", () => {
		const content = draftSlice();
		findLevel(content, 2).crops.push("corn");

		expect(listFailures(content)).toEqual([["unlockExists", "levels[1].crops[0]"]]);
	});

	it.each([
		["above the facility's highest", { facility: "feedMill", tier: 4 }],
		["of tier 1, which comes with the facility", { facility: "feedMill", tier: 1 }],
		["of a facility content doesn't have", { facility: "dairy", tier: 2 }],
	])("rejects a tier %s (#189)", (_name, tier) => {
		const content = draftSlice();
		findLevel(content, 4).tiers.push(tier);

		expect(listFailures(content)).toEqual([["unlockExists", "levels[3].tiers[1]"]]);
	});

	it("rejects a Level unlocking an order good with no orderGoods entry (#87, O3)", () => {
		const content = draftSlice();
		findLevel(content, 4).orderGoods.push("cookies");

		expect(listFailures(content)).toEqual([["unlockExists", "levels[3].orderGoods[0]"]]);
	});
});

describe("R5 listedOnce", () => {
	it("rejects a crop listed again at a later Level, which progress/ would ignore (#159)", () => {
		const content = draftSlice();
		findLevel(content, 3).crops.push("wheat");

		expect(listFailures(content)).toEqual([["listedOnce", "levels[2].crops[0]"]]);
	});

	it("rejects the later listing when the new one is at an earlier Level (#177)", () => {
		const content = draftSlice();
		findLevel(content, 4).addOns.push("loop");

		expect(listFailures(content)).toEqual([["listedOnce", "levels[4].addOns[0]"]]);
	});

	it("rejects an id listed twice at one Level", () => {
		const content = draftSlice();
		findLevel(content, 2).orderGoods.push("egg");

		expect(listFailures(content)).toEqual([["listedOnce", "levels[1].orderGoods[2]"]]);
	});

	it("rejects a tier listed at two Levels (#189)", () => {
		const content = draftSlice();
		findLevel(content, 5).tiers.push({ facility: "feedMill", tier: 2 });

		expect(listFailures(content)).toEqual([["listedOnce", "levels[4].tiers[2]"]]);
	});
});

describe("R6 listedSomewhere", () => {
	it("rejects an add-on no Level lists (MUST-05.5)", () => {
		const content = draftSlice();
		findLevel(content, 4).addOns = [];

		expect(listFailures(content)).toEqual([["listedSomewhere", "addOns.collector"]]);
	});

	it("rejects a tier row no Level lists (#189)", () => {
		const content = draftSlice();
		findLevel(content, 5).tiers = [{ facility: "feedMill", tier: 3 }];

		expect(listFailures(content)).toEqual([["listedSomewhere", "facilities[1].tiers[1]"]]);
	});

	it("rejects an order good no Level lists (#87, O3)", () => {
		const content = draftSlice();
		findLevel(content, 3).orderGoods = [];

		expect(listFailures(content)).toEqual([["listedSomewhere", "orderGoods[3]"]]);
	});
});
