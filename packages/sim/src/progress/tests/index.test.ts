import { describe, expect, it } from "vitest";

import { sliceContent } from "../../content/index.js";
import { createSim } from "../../sim/index.js";
import { cropLocked, gainXp, levelOf, prepareProgressRules } from "../index.js";

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

describe("cropLocked", () => {
	it.each([
		["wheat at Level 1", "wheat", 0, null],
		["a crop no Level lists", "rye", 1_000, "The crop rye isn't unlocked at any Level."],
	])("says whether a crop can be planted: %s (MUST-01.1, 01.5)", (_name, crop, xp, reason) => {
		expect(cropLocked(crop, xp, rules)).toBe(reason);
	});
});
