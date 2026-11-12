import { describe, expect, it } from "vitest";

import { draftSlice, findCrop, findLevel, findOrderGood, listFailures } from "./draft.js";

describe("R25 orderSlots", () => {
	it("rejects a board of 2 slots at Level 1 (MUST-04.1)", () => {
		const content = draftSlice();
		findLevel(content, 1).orderSlots = 2;

		expect(listFailures(content)).toEqual([["orderSlots", "levels[0].orderSlots"]]);
	});

	it("rejects slots summing to 10, naming the Level that passes 9 (MUST-04.1)", () => {
		const content = draftSlice();
		findLevel(content, 5).orderSlots = 4;

		expect(listFailures(content)).toEqual([["orderSlots", "levels[4].orderSlots"]]);
	});

	it("accepts slots summing to 9", () => {
		const content = draftSlice();
		findLevel(content, 5).orderSlots = 3;

		expect(listFailures(content)).toEqual([]);
	});
});

describe("R26 refillDelays", () => {
	it("rejects a discard that waits no longer than a delivery (MUST-04.5)", () => {
		const content = draftSlice();
		findLevel(content, 5).refillSeconds.discarded = 60;

		expect(listFailures(content)).toEqual([["refillDelays", "levels[4].refillSeconds.discarded"]]);
	});

	it("rejects a delay that gets longer at a higher Level (MUST-04.5)", () => {
		const content = draftSlice();
		findLevel(content, 3).refillSeconds.delivered = 150;

		expect(listFailures(content)).toEqual([["refillDelays", "levels[2].refillSeconds.delivered"]]);
	});

	it("rejects a discarded delay that gets longer at a higher Level (MUST-04.5)", () => {
		const content = draftSlice();
		findLevel(content, 4).refillSeconds.discarded = 250;

		expect(listFailures(content)).toEqual([["refillDelays", "levels[3].refillSeconds.discarded"]]);
	});
});

describe("R27 orderGoodProduced", () => {
	it("rejects an order good no route produces (#87, O4)", () => {
		const content = draftSlice();
		content.orderGoods.push({ good: "milk", min: 1, max: 2, coins: 10, xp: 3 });
		findLevel(content, 4).orderGoods.push("milk");

		expect(listFailures(content)).toEqual([["orderGoodProduced", "orderGoods[4].good"]]);
	});
});

describe("R28 firstOrderCrop", () => {
	it("rejects a Level 1 that unlocks no crop for orders, which createSim throws on (#87, O5)", () => {
		const content = draftSlice();
		findLevel(content, 1).orderGoods = [];
		findLevel(content, 2).orderGoods.push("wheat");

		expect(listFailures(content)).toEqual([["firstOrderCrop", "levels[0].orderGoods"]]);
	});
});

describe("R29 orderAmounts", () => {
	it("rejects an order good asked for 0 at least (#87, O6)", () => {
		const content = draftSlice();
		findOrderGood(content, "egg").min = 0;

		expect(listFailures(content)).toEqual([["orderAmounts", "orderGoods[2].min"]]);
	});

	it("rejects a max below the min (#87, O6)", () => {
		const content = draftSlice();
		findOrderGood(content, "egg").max = 0;

		expect(listFailures(content)).toEqual([["orderAmounts", "orderGoods[2].max"]]);
	});
});

describe("R31 orderXp", () => {
	it("rejects an order paying less XP per bread than baking it (MUST-05.2, O7)", () => {
		const content = draftSlice();
		findOrderGood(content, "bread").xp = 1;

		expect(listFailures(content)).toEqual([["orderXp", "orderGoods[3].xp"]]);
	});

	it("rejects an order paying less XP per wheat than a harvest: 3 XP for 2 (MUST-05.2)", () => {
		const content = draftSlice();
		findCrop(content, "wheat").xp = 3;

		expect(listFailures(content)).toEqual([["orderXp", "orderGoods[0].xp"]]);
	});

	it("accepts an order paying the same XP per wheat as a harvest: 2 XP for 2", () => {
		const content = draftSlice();
		findCrop(content, "wheat").xp = 2;

		expect(listFailures(content)).toEqual([]);
	});
});
