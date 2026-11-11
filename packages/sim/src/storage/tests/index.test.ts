import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { Content, FarmState } from "../../index.js";
import { countHeld, prepareStorageRules, put, take } from "../index.js";

const content: Content = { ...sliceContent, silo: { capacity: 10 }, barn: { capacity: 5 } };
const rules = prepareStorageRules(content);
const farm: FarmState = {
	...createSim(content).newFarm("farm-1"),
	silo: { wheat: 4 },
	barn: { chickenFeed: 2 },
};

describe("put", () => {
	it("adds crops to the silo and every other good to the barn (MUST-06.4)", () => {
		const silo = put(farm, { good: "wheat", amount: 6 }, "the harvest", rules);
		const barn = put(farm, { good: "egg", amount: 3 }, "collecting", rules);

		expect(silo).toEqual({ ok: true, state: { ...farm, silo: { wheat: 10 } } });
		expect(barn).toEqual({ ok: true, state: { ...farm, barn: { chickenFeed: 2, egg: 3 } } });
	});

	it("is refused if the store can't hold them all, naming the room left", () => {
		expect(put(farm, { good: "egg", amount: 4 }, "collecting the eggs", rules)).toEqual({
			ok: false,
			reason: "The barn has room for 3 more goods, and collecting the eggs needs room for 4 egg.",
		});
		const full = { ...farm, silo: { wheat: 9 } };
		expect(put(full, { good: "wheat", amount: 2 }, "the harvest", rules)).toEqual({
			ok: false,
			reason: "The silo has room for 1 more crop, and the harvest needs room for 2 wheat.",
		});
	});
});

describe("take", () => {
	it("takes every input from its store, and drops a good's key at 0", () => {
		const inputs = [
			{ good: "wheat", amount: 1 },
			{ good: "chickenFeed", amount: 2 },
		];

		expect(take(farm, inputs, "Making bread", rules)).toEqual({
			ok: true,
			state: { ...farm, silo: { wheat: 3 }, barn: {} },
		});
	});

	it("is refused, naming the first input that is short", () => {
		const inputs = [
			{ good: "chickenFeed", amount: 3 },
			{ good: "wheat", amount: 9 },
		];

		expect(take(farm, inputs, "Feeding", rules)).toEqual({
			ok: false,
			reason: "Feeding needs 3 chickenFeed, and the barn has 2.",
		});
	});
});

describe("countHeld", () => {
	it("counts a good in its store, 0 when it has no key", () => {
		expect(countHeld(farm, "chickenFeed", rules)).toBe(2);
		expect(countHeld(farm, "wheat", rules)).toBe(4);
		expect(countHeld(farm, "egg", rules)).toBe(0);
	});
});
