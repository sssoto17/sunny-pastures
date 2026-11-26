import { describe, expect, it } from "vitest";

import { findShortfall, formatTimeLeft, nameGood } from "../goods";

describe("formatTimeLeft", () => {
	it("rounds up to the second and drops zero parts", () => {
		expect(formatTimeLeft(300_000, 0)).toBe("5 min");
		expect(formatTimeLeft(239_001, 0)).toBe("4 min");
		expect(formatTimeLeft(59_500, 0)).toBe("1 min");
		expect(formatTimeLeft(45_000, 0)).toBe("45 s");
		expect(formatTimeLeft(3_605_000, 0)).toBe("1 h 5 s");
	});

	it("never goes below 0 s", () => {
		expect(formatTimeLeft(1_000, 5_000)).toBe("0 s");
	});
});

describe("findShortfall", () => {
	it("names every short good, joined as a sentence", () => {
		const needs = [
			{ good: "wheat", amount: 2, have: 0 },
			{ good: "egg", amount: 3, have: 0 },
			{ good: "chickenFeed", amount: 2, have: 1 },
			{ good: "bread", amount: 1, have: 1 },
		];

		expect(findShortfall(needs)).toBe(
			"You need 2 more wheat, 3 more eggs and 1 more chicken feed to deliver this order.",
		);
	});

	it("is null when the farm holds every good", () => {
		expect(findShortfall([{ good: "wheat", amount: 2, have: 5 }])).toBeNull();
	});
});

describe("nameGood", () => {
	it("uses the singular for one, and the id for a good with no name", () => {
		expect(nameGood("egg", 1)).toBe("egg");
		expect(nameGood("truffle", 2)).toBe("truffle");
	});
});
