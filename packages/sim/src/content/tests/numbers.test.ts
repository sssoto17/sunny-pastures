import { describe, expect, it } from "vitest";

import { checkContent, sliceContent } from "../index.js";
import { draftSlice, findCrop, findLevel, findPen, findRecipe, listFailures } from "./draft.js";

describe("checkContent on the slice", () => {
	it("finds no failure in the slice content (MUST-10.4, #89)", () => {
		expect(checkContent(sliceContent)).toEqual([]);
	});

	it("names the rule, the path and the value in each failure", () => {
		const content = draftSlice();
		findCrop(content, "wheat").growSeconds = 0;

		expect(checkContent(content)).toEqual([
			{
				rule: "timer",
				path: "crops.wheat.growSeconds",
				message:
					"crops.wheat.growSeconds is 0: a timer is a whole number of seconds from 10 to 86400 (MUST-10.4).",
			},
		]);
	});
});

describe("R1 safeInteger", () => {
	it.each([
		["a fraction", 1.5, "1.5"],
		["a negative", -1, "-1"],
		["-0", -0, "-0"],
		["past MAX_SAFE_INTEGER", 2 ** 53, String(2 ** 53)],
	])("rejects %s as a Level's coins (D16)", (_name, coins, shown) => {
		const content = draftSlice();
		findLevel(content, 2).coins = coins;

		expect(checkContent(content)).toEqual([
			{
				rule: "safeInteger",
				path: "levels[1].coins",
				message: `levels[1].coins is ${shown}: content numbers are safe integers of 0 or more (D16).`,
			},
		]);
	});

	it("checks numbers at every depth: a recipe input's amount and an add-on's price (#177)", () => {
		const content = draftSlice();
		const [wheat] = findRecipe(content, "bakery", "bread").inputs;
		if (wheat !== undefined) wheat.amount = 2.5;
		content.addOns.loop.price = -80;

		expect(listFailures(content)).toEqual([
			["safeInteger", "facilities[1].recipes.bread.inputs[0].amount"],
			["safeInteger", "addOns.loop.price"],
		]);
	});
});

describe("R2 timer", () => {
	it("rejects a crop's grow time of 9 s (MUST-10.4)", () => {
		const content = draftSlice();
		findCrop(content, "wheat").growSeconds = 9;

		expect(listFailures(content)).toEqual([["timer", "crops.wheat.growSeconds"]]);
	});

	it("rejects a pen's laying time of 0 s, which breaks advance (#86)", () => {
		const content = draftSlice();
		findPen(content, "chickenPen").seconds = 0;

		expect(listFailures(content)).toEqual([["timer", "pens[0].seconds"]]);
	});

	it("rejects refill delays above 24 h at Level 1 (MUST-04.5)", () => {
		const content = draftSlice();
		findLevel(content, 1).refillSeconds = {
			delivered: 86_401,
			discarded: 86_402,
		};

		expect(listFailures(content)).toEqual([
			["timer", "levels[0].refillSeconds.delivered"],
			["timer", "levels[0].refillSeconds.discarded"],
		]);
	});

	// A fraction is both an unsafe number (R1) and not a whole number of seconds (MUST-10.4).
	it("rejects a fractional timer, 30.5 s", () => {
		const content = draftSlice();
		findCrop(content, "wheat").growSeconds = 30.5;

		expect(listFailures(content)).toEqual([
			["safeInteger", "crops.wheat.growSeconds"],
			["timer", "crops.wheat.growSeconds"],
		]);
	});

	it("accepts the bounds, 10 s and 86400 s", () => {
		const content = draftSlice();
		findCrop(content, "wheat").growSeconds = 10;
		findPen(content, "chickenPen").seconds = 86_400;

		expect(listFailures(content)).toEqual([]);
	});
});
