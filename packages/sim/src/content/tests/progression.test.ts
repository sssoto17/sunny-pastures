import { describe, expect, it } from "vitest";

import { draftSlice, findLevel, listFailures } from "./draft.js";

describe("R7 levelThresholds", () => {
	it("rejects Level 1 above 0 XP (MUST-10.4)", () => {
		const content = draftSlice();
		findLevel(content, 1).xp = 1;

		expect(listFailures(content)).toEqual([["levelThresholds", "levels[0].xp"]]);
	});

	it("rejects a threshold equal to the one before: they rise strictly (#160)", () => {
		const content = draftSlice();
		findLevel(content, 3).xp = findLevel(content, 2).xp;

		expect(listFailures(content)).toEqual([["levelThresholds", "levels[2].xp"]]);
	});

	it("rejects a threshold below the one before", () => {
		const content = draftSlice();
		findLevel(content, 5).xp = 59;

		expect(listFailures(content)).toEqual([["levelThresholds", "levels[4].xp"]]);
	});

	it("rejects an empty Level table", () => {
		const content = draftSlice();
		content.levels = [];

		expect(listFailures(content)).toContainEqual(["levelThresholds", "levels"]);
	});
});

describe("R8 wheatAtLevel1", () => {
	// Wheat is the slice's only crop, so Level 1 then unlocks no crop planted at Level 1 for orders
	// either: one value can't break MUST-01.5 without #87's O5.
	it("rejects wheat unlocked at Level 2 (MUST-01.5)", () => {
		const content = draftSlice();
		findLevel(content, 1).crops = [];
		findLevel(content, 2).crops = ["wheat"];

		expect(listFailures(content)).toEqual([
			["firstOrderCrop", "levels[0].orderGoods"],
			["wheatAtLevel1", "levels[0].crops"],
		]);
	});
});

describe("R12 plotPriceRises", () => {
	it("rejects free plots (#160)", () => {
		const content = draftSlice();
		content.plotPrice.first = 0;

		expect(listFailures(content)).toEqual([["plotPriceRises", "plotPrice.first"]]);
	});

	it.each([
		[1, 1500],
		[2, 1499],
	])(
		"rejects first %i with growthPerMille %i: rounded down, a plot costs no more (#159)",
		(first, growthPerMille) => {
			const content = draftSlice();
			content.plotPrice = { first, growthPerMille };

			expect(listFailures(content)).toEqual([["plotPriceRises", "plotPrice.growthPerMille"]]);
		},
	);

	it("accepts first 2 with growthPerMille 1500: 2, 3, 4, … each rises by at least 1", () => {
		const content = draftSlice();
		content.plotPrice = { first: 2, growthPerMille: 1500 };

		expect(listFailures(content)).toEqual([]);
	});
});

describe("R13 plotPriceSafe", () => {
	// 1,000,000 × 10 per plot: the step to plot 7 is 10^15, and to plot 8, the slice's last, 10^16.
	it("rejects a price step past MAX_SAFE_INTEGER at the last plot the Level table allows (#160)", () => {
		const content = draftSlice();
		content.plotPrice = { first: 1_000_000, growthPerMille: 10_000 };

		expect(listFailures(content)).toEqual([["plotPriceSafe", "plotPrice"]]);
	});

	// A negative first price breaks R1 and R12, and its steps run past MIN_SAFE_INTEGER: one run
	// reports all three, so fixing one doesn't uncover the next.
	it("reports an unsafe step alongside a plot price that doesn't rise", () => {
		const content = draftSlice();
		content.plotPrice = { first: -1_000_000_000_000_000, growthPerMille: 10_000 };

		expect(listFailures(content)).toEqual([
			["safeInteger", "plotPrice.first"],
			["plotPriceRises", "plotPrice.first"],
			["plotPriceSafe", "plotPrice"],
		]);
	});

	it("accepts the same curve when the Level table allows one plot fewer", () => {
		const content = draftSlice();
		content.plotPrice = { first: 1_000_000, growthPerMille: 10_000 };
		findLevel(content, 5).plots = 1;

		expect(listFailures(content)).toEqual([]);
	});
});
