import { describe, expect, it } from "vitest";

import { findOwned, findRule, findUnowned, replaceOwned } from "../index.js";

const rules = [{ id: "a" }, { id: "b" }] as const;
const describeNone = (index: number): string => `none ${String(index)}`;

describe("findRule", () => {
	it.each([-1, 0.5, 2, Number.NaN])("is null for %s", (index) => {
		expect(findRule(rules, index)).toBeNull();
	});

	it("returns the rule at a valid index", () => {
		expect(findRule(rules, 1)).toBe(rules[1]);
	});
});

describe("findOwned", () => {
	it("returns the rule and entry of a bought one", () => {
		expect(findOwned(["x", null], rules, 0, describeNone)).toEqual({ rule: rules[0], owned: "x" });
	});

	it("words an unbought one and a missing rule as sentences", () => {
		expect(findOwned(["x", null], rules, 1, describeNone)).toBe("The b isn't bought.");
		expect(findOwned(["x", null], rules, 5, describeNone)).toBe("none 5");
	});

	it("throws on a farm with no entry for a content item", () => {
		expect(() => findOwned(["x"], rules, 1, describeNone)).toThrow(RangeError);
	});
});

describe("findUnowned", () => {
	it("returns the rule of an unbought one", () => {
		expect(findUnowned([null, null], rules, 1, describeNone)).toBe(rules[1]);
	});

	it("refuses a bought one and a missing rule", () => {
		expect(findUnowned(["x", null], rules, 0, describeNone)).toBe("The a is already bought.");
		expect(findUnowned(["x", null], rules, 2, describeNone)).toBe("none 2");
	});

	it("throws on a farm with no entry for a content item", () => {
		expect(() => findUnowned([null], rules, 1, describeNone)).toThrow(RangeError);
	});
});

describe("replaceOwned", () => {
	it("sets one entry and keeps the others", () => {
		expect(replaceOwned([null, "y"], 0, "x")).toEqual(["x", "y"]);
	});

	it.each([-1, 2])("throws for index %s, rather than dropping the entry", (index) => {
		expect(() => replaceOwned([null, null], index, "x")).toThrow(RangeError);
	});
});
