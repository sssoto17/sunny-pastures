import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { Action, FarmState } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";

const sim = createSim(sliceContent);
// The slice's chicken pen (#86's "Decided by the lane"), written out rather than read from content.
const layMs = 180_000;
const level2 = 10;

const buy = { type: "buyPen", pen: 0 } as const;
const feed = { type: "feed", pen: 0 } as const;

/** Applies each action at `at`; fails the test on a refusal. */
const applyAll = (farm: FarmState, actions: readonly Action[], at: number): FarmState =>
	actions.reduce((current, action) => expectAccepted(sim.apply(current, action, at)), farm);

/** A new farm at Level 2 with the chicken pen bought. */
const withPen = (): FarmState =>
	applyAll({ ...sim.newFarm("farm-1"), xp: level2, coins: 30 }, [buy], 0);

const idle = { status: "idle" } as const;
const producing = (readyAt: number) => ({ status: "producing", readyAt }) as const;

describe("a new farm's pens", () => {
	it("has every content pen unbought, and the start's chicken feed in the barn", () => {
		const farm = sim.newFarm("farm-1");

		expect(farm.pens).toEqual([null]);
		expect(farm.barn).toEqual({ chickenFeed: 6 });
	});
});

describe("buying a pen", () => {
	it("adds it with an empty trough, idle chickens and no eggs, for its price (spec decision 1)", () => {
		const farm = withPen();

		expect(farm.coins).toBe(0);
		expect(farm.pens).toEqual([{ trough: 0, animals: [idle, idle, idle], products: 0 }]);
	});

	it.each([
		[
			"before its Level",
			{ xp: 0, coins: 30 },
			0,
			"The chickenPen isn't unlocked: it unlocks at Level 2, and you're at Level 1.",
		],
		[
			"with too few coins",
			{ xp: level2, coins: 29 },
			0,
			"The chickenPen costs 30 coins, and the farm has 29.",
		],
		["for a pen content doesn't have", { xp: level2, coins: 30 }, 1, "There is no pen 2."],
		["for a pen index that isn't one", { xp: level2, coins: 30 }, -1, "There is no pen 0."],
	])("is refused %s", (_name, progress, pen, reason) => {
		const farm = { ...sim.newFarm("farm-1"), ...progress };

		expect(sim.apply(farm, { type: "buyPen", pen }, 0)).toEqual({ ok: false, reason });
	});

	it("is refused once bought, so an action sent twice buys one pen", () => {
		const farm = { ...withPen(), coins: 30 };

		expect(sim.apply(farm, buy, 0)).toEqual({
			ok: false,
			reason: "The chickenPen is already bought.",
		});
	});
});

describe("feeding", () => {
	it("moves one portion into the trough, which an idle chicken eats at once (MUST-02.2, 02.3)", () => {
		const farm = applyAll(withPen(), [feed], 1_000);

		expect(farm.barn).toEqual({ chickenFeed: 5 });
		expect(farm.pens[0]).toEqual({
			trough: 0,
			animals: [producing(1_000 + layMs), idle, idle],
			products: 0,
		});
	});

	it("fills the trough once every chicken is eating, then is refused while it is full", () => {
		const farm = applyAll(withPen(), [feed, feed, feed, feed], 1_000);

		expect(farm.barn).toEqual({ chickenFeed: 2 });
		expect(farm.pens[0]?.trough).toBe(1);
		expect(sim.apply(farm, feed, 1_000)).toEqual({
			ok: false,
			reason: "The chickenPen's trough is full.",
		});
	});

	it("is refused when the barn has no chicken feed", () => {
		const farm = { ...withPen(), barn: {} };

		expect(sim.apply(farm, feed, 0)).toEqual({
			ok: false,
			reason: "Feeding the chickenPen needs 1 chickenFeed, and the barn has 0.",
		});
	});

	it.each([
		["a pen that isn't bought", sim.newFarm("farm-1"), 0, "The chickenPen isn't bought."],
		["a pen content doesn't have", sim.newFarm("farm-1"), 3, "There is no pen 4."],
	])("is refused for %s", (_name, farm, pen, reason) => {
		expect(sim.apply(farm, { type: "feed", pen }, 0)).toEqual({ ok: false, reason });
	});
});
