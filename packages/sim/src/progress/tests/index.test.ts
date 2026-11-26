import { describe, expect, it } from "vitest";

import { sliceContent } from "../../content/index.js";
import { levelOf as levelOfFromEntry } from "../../index.js";
import { createSim } from "../../sim/index.js";
import { cropLocked, gainXp, levelOf, prepareProgressRules, purchase } from "../index.js";

const rules = prepareProgressRules(sliceContent);
const newFarm = createSim(sliceContent).newFarm("farm-1");

describe("levelOf", () => {
	it.each([
		[0, 1],
		[9, 1],
		[10, 2],
		[29, 2],
		[30, 3],
		[100, 5],
		[1_000_000, 5],
	])("puts a farm with %i XP at Level %i (MUST-05.3)", (xp, level) => {
		expect(levelOf(xp, rules)).toBe(level);
	});

	it.each([
		[0, 1],
		[29, 2],
		[30, 3],
		[1_000_000, 5],
	])(
		"reads the Level table from content too, as the client does (#667): %i XP is Level %i",
		(xp, level) => {
			expect(levelOfFromEntry(xp, sliceContent)).toBe(level);
		},
	);
});

describe("gainXp", () => {
	it.each([
		["below the next Level", 0, 9, 0],
		["exactly to Level 2's XP", 0, 10, 20],
		["past one Level, inside the next", 5, 20, 20],
		["across Levels 2, 3 and 4 at once", 0, 60, 20 + 30 + 40],
		["from a Level already paid", 10, 15, 0],
		["past the last Level", 100, 500, 0],
	])("pays level-up coins once per Level reached: %s (MUST-05.4)", (_name, from, to, paid) => {
		const farm = { ...newFarm, xp: from };
		const after = gainXp(farm, to - from, rules);

		expect(after.xp).toBe(to);
		expect(after.coins).toBe(farm.coins + paid);
	});

	it("returns the farm itself for no XP", () => {
		expect(gainXp(newFarm, 0, rules)).toBe(newFarm);
	});
});

describe("purchase", () => {
	const offer = { what: "Plot 7", level: 2, price: 20 };
	const level2 = { ...newFarm, xp: 10, coins: 30 };

	it("takes the price once the farm's Level unlocks it (spec decision 1, MUST-05.6)", () => {
		expect(purchase(level2, offer, rules)).toEqual({ ok: true, state: { ...level2, coins: 10 } });
	});

	it("spends the last coins when the farm has exactly the price (MUST-05.1)", () => {
		const exact = { ...level2, coins: 20 };

		expect(purchase(exact, offer, rules)).toEqual({ ok: true, state: { ...exact, coins: 0 } });
	});

	it.each([
		[
			"below the Level that unlocks it",
			{ ...level2, xp: 9 },
			offer,
			"Plot 7 isn't unlocked: it unlocks at Level 2, and you're at Level 1.",
		],
		[
			"with too few coins (MUST-05.1)",
			{ ...level2, coins: 19 },
			offer,
			"Plot 7 costs 20 coins, and the farm has 19.",
		],
	])("is refused %s", (_name, farm, wanted, reason) => {
		expect(purchase(farm, wanted, rules)).toEqual({ ok: false, reason });
	});
});

describe("cropLocked", () => {
	it.each([
		["wheat at Level 1", "wheat", 0, null],
		["a crop no Level lists", "rye", 1_000, "The crop rye isn't unlocked at any Level."],
	])("says whether a crop can be planted: %s (MUST-01.1, 01.5)", (_name, crop, xp, reason) => {
		expect(cropLocked(crop, xp, rules)).toBe(reason);
	});

	it("unlocks a crop at the first Level that lists it", () => {
		// Test content: corn listed at Level 2 and again at Level 4.
		const [level1, level2, level3, level4, ...rest] = sliceContent.levels;
		const twice = prepareProgressRules({
			...sliceContent,
			levels: [
				level1,
				{ ...level2, crops: ["corn"] },
				level3,
				{ ...level4, crops: ["corn"] },
				...rest,
			],
		});

		expect(cropLocked("corn", level2.xp, twice)).toBeNull();
		expect(cropLocked("corn", level2.xp - 1, twice)).toBe(
			"The crop corn isn't unlocked: it unlocks at Level 2, and you're at Level 1.",
		);
	});
});

describe("prepareProgressRules", () => {
	it("unlocks each order good at the first Level that lists it (MUST-04.2, #87)", () => {
		const rules = prepareProgressRules(sliceContent);

		expect([...rules.orderGoodLevels].sort()).toEqual([
			["bread", 3],
			["chickenFeed", 2],
			["egg", 2],
			["wheat", 1],
		]);
	});
});
