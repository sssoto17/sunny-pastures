import { describe, expect, it } from "vitest";

import type { Action } from "@sunny-pastures/sim";

import { readAction } from "../actions";

// One good action per sim variant, written out by hand. Keyed by type, so this file stops
// compiling when the sim adds a variant (packages/sim/src/state, `Action`).
const goodActions = {
	plant: { type: "plant", plot: 0, crop: "wheat" },
	harvest: { type: "harvest", plot: 3 },
	buyPlot: { type: "buyPlot", plot: 6 },
	buyFacility: { type: "buyFacility", facility: 1 },
	startJob: { type: "startJob", facility: 0, recipe: "bread" },
	collect: { type: "collect", facility: 2 },
	buyAddOn: { type: "buyAddOn", facility: 0, addOn: "loop" },
	buyTier: { type: "buyTier", facility: 0, tier: 2 },
	buyPen: { type: "buyPen", pen: 0 },
	feed: { type: "feed", pen: 1 },
	collectProducts: { type: "collectProducts", pen: 1 },
	deliver: { type: "deliver", slot: 4 },
	discard: { type: "discard", slot: 0 },
} as const satisfies { [T in Action["type"]]: Extract<Action, { type: T }> };

const variants = Object.values(goodActions).map((action: Action) => [action.type, action] as const);

// Each variant's fields with a wrong value of every kind the guards refuse.
const badValues: readonly unknown[] = [-1, -0, 1.5, 2 ** 53, "1", null, true, [], {}];
const badStrings: readonly unknown[] = [
	7,
	null,
	["wheat"],
	{ id: "wheat" },
	"w".repeat(65),
	"wheat\u0000",
	"wh\neat",
	"\ud800wheat",
];

function fieldsOf(action: Action): readonly [string, unknown][] {
	return Object.entries(action).filter(([key]) => key !== "type");
}

describe("readAction", () => {
	it.each(variants)("reads a good %s action as itself", (_, action) => {
		expect(readAction(structuredClone(action))).toStrictEqual(action);
	});

	it.each(variants)("refuses a %s action with a wrong value in any field", (_, action) => {
		for (const [key, value] of fieldsOf(action)) {
			const bad = typeof value === "number" ? badValues : badStrings;
			for (const wrong of bad) {
				expect(readAction({ ...action, [key]: wrong }), `${key}: ${String(wrong)}`).toBeNull();
			}
		}
	});

	it.each(variants)("refuses a %s action with a field missing", (_, action) => {
		for (const [key] of fieldsOf(action)) {
			const missing = Object.fromEntries(Object.entries(action).filter(([own]) => own !== key));
			expect(readAction(missing), key).toBeNull();
		}
	});

	// T1, T2 (MUST-11.1): a request carries no time, result or quantity; one that does is refused.
	it.each(variants)(
		"refuses a %s action with an extra key: a time, a result, a quantity",
		(_, action) => {
			for (const extra of [{ at: 1_700_000_000_000 }, { result: "ok" }, { quantity: 99 }]) {
				expect(readAction({ ...action, ...extra })).toBeNull();
			}
		},
	);

	it("refuses an action that takes another variant's fields", () => {
		expect(readAction({ type: "harvest", plot: 0, crop: "wheat" })).toBeNull();
		expect(readAction({ type: "plant", facility: 0, recipe: "bread" })).toBeNull();
	});

	it("reads a string of 64 characters", () => {
		const crop = "w".repeat(64);

		expect(readAction({ type: "plant", plot: 0, crop })).toStrictEqual({
			type: "plant",
			plot: 0,
			crop,
		});
	});

	it("leaves an add-on the sim doesn't know to the sim, which refuses it", () => {
		expect(readAction({ type: "buyAddOn", facility: 0, addOn: "turbo" })).toStrictEqual({
			type: "buyAddOn",
			facility: 0,
			addOn: "turbo",
		});
	});

	it.each([
		["an unknown type", { type: "teleport", plot: 0 }],
		["a type inherited from Object", { type: "toString" }],
		["the prototype's key as a type", { type: "__proto__" }],
		["no type", { plot: 0 }],
		["a type that is not a string", { type: 1, plot: 0 }],
		["null", null],
		["an array", [{ type: "harvest", plot: 0 }]],
		["a string", "harvest"],
	])("refuses %s", (_, value) => {
		expect(readAction(value)).toBeNull();
	});

	it("refuses an own __proto__ key as an extra key", () => {
		expect(readAction(JSON.parse('{"type":"harvest","plot":0,"__proto__":{"plot":1}}'))).toBeNull();
	});
});
