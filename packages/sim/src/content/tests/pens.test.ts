import { describe, expect, it } from "vitest";

import { draftSlice, findFacility, findLevel, findPen, findRecipe, listFailures } from "./draft.js";

describe("R21 penSize", () => {
	it.each([
		["no animals", "animals", 0],
		["a trough of 2 portions at the start (MUST-02.5)", "troughCapacity", 2],
	] as const)("rejects a pen with %s", (_name, field, value) => {
		const content = draftSlice();
		findPen(content, "chickenPen")[field] = value;

		expect(listFailures(content)).toEqual([["penSize", `pens[0].${field}`]]);
	});
});

describe("R22 penGoods", () => {
	it.each([
		["eats a crop", { feed: "wheat", product: "egg" }, "pens[1].feed"],
		["produces a crop", { feed: "chickenFeed", product: "wheat" }, "pens[1].product"],
	])("rejects a pen that %s, which storage/ would send to the silo (#86)", (_name, goods, path) => {
		const content = draftSlice();
		content.pens.push({
			...findPen(content, "chickenPen"),
			id: "duckPen",
			...goods,
		});
		findLevel(content, 3).pens.push("duckPen");

		expect(listFailures(content)).toEqual([["penGoods", path]]);
	});
});

describe("R23 animals", () => {
	it("rejects a slice with no chickens (MUST-02.1)", () => {
		const content = draftSlice();
		findPen(content, "chickenPen").id = "henHouse";
		findLevel(content, 2).pens = ["henHouse"];

		expect(listFailures(content)).toEqual([["animals", "pens"]]);
	});

	it("rejects chickens that eat something other than chicken feed (MUST-02.1)", () => {
		const content = draftSlice();
		findFacility(content, "feedMill").recipes["mash"] = {
			...findRecipe(content, "feedMill", "chickenFeed"),
			output: { good: "mash", amount: 2 },
		};
		findPen(content, "chickenPen").feed = "mash";

		expect(listFailures(content)).toEqual([["animals", "pens[0].feed"]]);
	});
});
