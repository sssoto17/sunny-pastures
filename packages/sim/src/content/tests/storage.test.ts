import { describe, expect, it } from "vitest";

import { checkContent, sliceContent } from "../index.js";
import type { Content } from "../index.js";
import { draftSlice, listFailures } from "./draft.js";

describe("R24 startBarn", () => {
	function withStartBarn(barn: unknown): Content {
		const start = { ...sliceContent.start, barn };
		return { ...sliceContent, start };
	}

	it("rejects a starting good with count 0: a good has a key only while its count is above 0", () => {
		expect(listFailures(withStartBarn({ egg: 0 }))).toEqual([["startBarn", "start.barn.egg"]]);
	});

	it("rejects starting goods that don't fit the barn (MUST-06.4)", () => {
		expect(listFailures(withStartBarn({ egg: 30, bread: 21 }))).toEqual([
			["startBarn", "start.barn"],
		]);
	});

	it("rejects starting goods that aren't a map of goods to counts", () => {
		expect(listFailures(withStartBarn([]))).toEqual([["startBarn", "start.barn"]]);
	});

	it("accepts starting goods that fill the barn exactly", () => {
		expect(checkContent(withStartBarn({ egg: 30, bread: 20 }))).toEqual([]);
	});
});

describe("R30 orderFits", () => {
	// 4 + 3 + 2 = 9 barn goods: two kinds (4 + 3 = 7) would fit, but an order asks for up to 3.
	it("rejects a barn smaller than the largest order of barn goods (#87, O8)", () => {
		const content = draftSlice();
		content.barn.capacity = 8;

		expect(listFailures(content)).toEqual([["orderFits", "barn.capacity"]]);
	});

	it("rejects a silo smaller than the largest wheat order (#87, O8)", () => {
		const content = draftSlice();
		content.silo.capacity = 5;

		expect(listFailures(content)).toEqual([["orderFits", "silo.capacity"]]);
	});

	it("accepts stores that hold the largest orders exactly", () => {
		const content = draftSlice();
		content.barn.capacity = 9;
		content.silo.capacity = 6;

		expect(listFailures(content)).toEqual([]);
	});
});
