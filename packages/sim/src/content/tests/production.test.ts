import { describe, expect, it } from "vitest";

import {
	draftSlice,
	findCrop,
	findFacility,
	findLevel,
	findRecipe,
	listFailures,
} from "./draft.js";

describe("R11 cropYield", () => {
	it("rejects a crop that can yield 0, which would store a silo key with count 0 (#152)", () => {
		const content = draftSlice();
		findCrop(content, "wheat").baseYield = 0;

		expect(listFailures(content)).toEqual([["cropYield", "crops.wheat.baseYield"]]);
	});
});

describe("R14 inputProduced", () => {
	it("rejects cookies before the eggs they need: chickens at Level 5, bakery tier 2 at 4 (#189)", () => {
		const content = draftSlice();
		findLevel(content, 2).pens = [];
		findLevel(content, 5).pens = ["chickenPen"];

		expect(listFailures(content)).toEqual([
			["inputProduced", "facilities[1].recipes.cookies.inputs[1].good"],
		]);
	});

	it("rejects a pen unlocked before its feed: the feed mill at Level 3, chickens at 2 (#86)", () => {
		const content = draftSlice();
		findLevel(content, 2).facilities = [];
		findLevel(content, 3).facilities.push("feedMill");

		expect(listFailures(content)).toEqual([["inputProduced", "pens[0].feed"]]);
	});

	it("accepts the route at the same Level as what needs it", () => {
		const content = draftSlice();
		findLevel(content, 2).pens = [];
		findLevel(content, 4).pens = ["chickenPen"];

		expect(listFailures(content)).toEqual([]);
	});

	// Rye flour is made from Level 2, but rye only grows from Level 5, so bread (Level 3) waits two
	// steps down the chain: each recipe's Level is the latest of its inputs' (#89's review).
	it("rejects an input whose own input is late: rye at Level 5, rye flour, bread at Level 3", () => {
		const content = draftSlice();
		content.crops["rye"] = { ...findCrop(content, "wheat") };
		findLevel(content, 5).crops.push("rye");
		findFacility(content, "feedMill").recipes["ryeFlour"] = {
			tier: 1,
			inputs: [{ good: "rye", amount: 2 }],
			output: { good: "ryeFlour", amount: 2 },
			seconds: 60,
			xp: 1,
		};
		findRecipe(content, "bakery", "bread").inputs = [{ good: "ryeFlour", amount: 3 }];

		expect(listFailures(content)).toEqual([
			["inputProduced", "facilities[0].recipes.ryeFlour.inputs[0].good"],
			["inputProduced", "facilities[1].recipes.bread.inputs[0].good"],
		]);
	});

	// Chicken feed from eggs and eggs from chicken feed: a cycle with no route in, so neither good
	// is ever produced, though each has a producer.
	it("rejects a cycle with no route into it", () => {
		const content = draftSlice();
		findRecipe(content, "feedMill", "chickenFeed").inputs = [{ good: "egg", amount: 2 }];

		expect(listFailures(content)).toEqual([
			["orderGoodProduced", "orderGoods[1].good"],
			["orderGoodProduced", "orderGoods[2].good"],
			["inputProduced", "facilities[0].recipes.chickenFeed.inputs[0].good"],
			["inputProduced", "facilities[1].recipes.cookies.inputs[1].good"],
			["inputProduced", "pens[0].feed"],
		]);
	});

	it("accepts a cycle once a route leads into it", () => {
		const content = draftSlice();
		const chickenFeed = findRecipe(content, "feedMill", "chickenFeed");
		findFacility(content, "feedMill").recipes["feedFromWheat"] = {
			...chickenFeed,
		};
		chickenFeed.inputs = [{ good: "egg", amount: 2 }];

		expect(listFailures(content)).toEqual([]);
	});
});

describe("R15 goodUsed", () => {
	it("rejects cookies without an animal product, which leaves eggs unused (MUST-03.6)", () => {
		const content = draftSlice();
		findRecipe(content, "bakery", "cookies").inputs = [
			{ good: "wheat", amount: 2 },
			{ good: "chickenFeed", amount: 2 },
		];

		expect(listFailures(content)).toEqual([
			["goodUsed", "pens[0].product"],
			["goodUsed", "facilities[1].recipes.cookies.inputs"],
		]);
	});

	it("rejects a crop no recipe takes (MUST-03.6)", () => {
		const content = draftSlice();
		content.crops["corn"] = { ...findCrop(content, "wheat") };
		findLevel(content, 3).crops.push("corn");

		expect(listFailures(content)).toEqual([["goodUsed", "crops.corn"]]);
	});
});

describe("R16 sliceRecipes", () => {
	it("rejects cookies at bakery tier 3 (MUST-03.1)", () => {
		const content = draftSlice();
		findRecipe(content, "bakery", "cookies").tier = 3;

		expect(listFailures(content)).toEqual([["sliceRecipes", "facilities[1].recipes.cookies.tier"]]);
	});

	// Without the recipe, no route makes bread for its orders either (#87's O4).
	it("rejects a bakery with no bread (MUST-03.1)", () => {
		const content = draftSlice();
		delete findFacility(content, "bakery").recipes["bread"];

		expect(listFailures(content)).toEqual([
			["orderGoodProduced", "orderGoods[3].good"],
			["sliceRecipes", "facilities[1].recipes"],
		]);
	});
});

describe("R16 sliceRecipes, without a bakery", () => {
	// Without the bakery, no route makes bread for its orders and no recipe takes eggs.
	it("rejects a slice with no bakery once, not once per recipe (#72 D1)", () => {
		const content = draftSlice();
		content.facilities = content.facilities.filter(({ id }) => id !== "bakery");
		findLevel(content, 3).facilities = [];
		findLevel(content, 4).tiers = [];
		findLevel(content, 5).tiers = [{ facility: "feedMill", tier: 3 }];

		expect(listFailures(content)).toEqual([
			["orderGoodProduced", "orderGoods[3].good"],
			["goodUsed", "pens[0].product"],
			["sliceRecipes", "facilities"],
		]);
	});
});
