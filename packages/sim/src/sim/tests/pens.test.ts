import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { Action, Content, FarmState } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";

const sim = createSim(sliceContent);
// The slice's chicken pen (#86's "Decided by the lane"), written out rather than read from content.
const layMs = 180_000;
const level2 = 10;

const buy = { type: "buyPen", pen: 0 } as const;
const feed = { type: "feed", pen: 0 } as const;
const collect = { type: "collectProducts", pen: 0 } as const;

/** Applies each action at `at`; fails the test on a refusal. */
const applyAll = (farm: FarmState, actions: readonly Action[], at: number): FarmState =>
	actions.reduce((current, action) => expectAccepted(sim.apply(current, action, at)), farm);

/** A new farm at Level 2 with the chicken pen bought and 6 chicken feed in the barn. */
const withPen = (): FarmState =>
	applyAll({ ...sim.newFarm("farm-1"), xp: level2, coins: 30, barn: { chickenFeed: 6 } }, [buy], 0);

const idle = { status: "idle" } as const;
const producing = (readyAt: number) => ({ status: "producing", readyAt }) as const;

describe("a new farm's pens", () => {
	it("has every content pen unbought", () => {
		expect(sim.newFarm("farm-1").pens).toEqual([null]);
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
		["for a pen index that isn't one", { xp: level2, coins: 30 }, -1, "There is no such pen."],
		["for an index that isn't an integer", { xp: level2, coins: 30 }, 0.5, "There is no such pen."],
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

	it("moves only what the barn holds when that is less than the trough's room (MUST-02.2)", () => {
		const [pen] = sliceContent.pens;
		const deep: Content = { ...sliceContent, pens: [{ ...pen, animals: 1, troughCapacity: 4 }] };
		const deepSim = createSim(deep);
		const bought = expectAccepted(
			deepSim.apply(
				{ ...deepSim.newFarm("farm-1"), xp: level2, coins: 30, barn: { chickenFeed: 3 } },
				buy,
				0,
			),
		);
		const farm = expectAccepted(deepSim.apply(bought, feed, 0));

		expect(farm.barn).toEqual({});
		expect(farm.pens[0]).toEqual({ trough: 2, animals: [producing(layMs)], products: 0 });
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

describe("a chicken producing", () => {
	it("lays its egg in the pen exactly its production time after eating (MUST-02.3)", () => {
		const fed = applyAll(withPen(), [feed], 1_000);

		expect(sim.advance(fed, 1_000 + layMs - 1).pens[0]?.products).toBe(0);
		expect(sim.advance(fed, 1_000 + layMs).pens[0]).toEqual({
			trough: 0,
			animals: [idle, idle, idle],
			products: 1,
		});
	});

	it("eats the next portion at the time it lays, while the player is away (MUST-02.3, 07.1)", () => {
		const fed = applyAll(withPen(), [feed, feed, feed], 0);
		const topped = applyAll(fed, [feed], 5_000);

		expect(sim.advance(topped, layMs).pens[0]).toEqual({
			trough: 0,
			animals: [producing(2 * layMs), idle, idle],
			products: 3,
		});
		expect(sim.advance(topped, 30 * layMs).pens[0]).toEqual({
			trough: 0,
			animals: [idle, idle, idle],
			products: 4,
		});
	});

	it("gives the last portion to the lowest slot when chickens lay at once (MUST-10.6)", () => {
		const fed = applyAll(withPen(), [feed, feed, feed, feed], 0);

		expect(sim.advance(fed, layMs).pens[0]?.animals).toEqual([producing(2 * layMs), idle, idle]);
	});

	it("keeps the laid time stored when it ate, under a later rules version (ADR-0006, section 7)", () => {
		const fed = applyAll(withPen(), [feed], 0);
		const [pen] = sliceContent.pens;
		const slower: Content = { ...sliceContent, pens: [{ ...pen, seconds: 600 }] };

		expect(createSim(slower).advance(fed, layMs).pens[0]?.products).toBe(1);
	});
});

describe("collecting from a pen", () => {
	const laid = (): FarmState => sim.advance(applyAll(withPen(), [feed, feed], 0), layMs);

	it("moves the eggs to the barn and gives XP for each (MUST-02.4, 05.2)", () => {
		const before = laid();
		const farm = expectAccepted(sim.apply(before, collect, layMs));

		expect(farm.barn).toEqual({ chickenFeed: 4, egg: 2 });
		expect(farm.pens[0]?.products).toBe(0);
		expect(farm.xp).toBe(before.xp + 2);
	});

	it("pays the level-up coins of the Level its eggs' XP reaches (MUST-05.4)", () => {
		// The slice's Level 3 is at 30 XP and pays 30 coins (#83); two eggs take 29 XP to 31.
		const before = { ...laid(), xp: 29, coins: 0 };
		const farm = expectAccepted(sim.apply(before, collect, layMs));

		expect(farm.xp).toBe(31);
		expect(farm.coins).toBe(30);
	});

	it("is refused if the barn can't hold them all", () => {
		const farm = { ...laid(), barn: { chickenFeed: 49 } };

		expect(sim.apply(farm, collect, layMs)).toEqual({
			ok: false,
			reason:
				"The barn has room for 1 more good, and collecting from the chickenPen needs room for 2 egg.",
		});
	});

	it.each([
		["with nothing laid", withPen(), 0, "The chickenPen has nothing to collect."],
		["from a pen that isn't bought", sim.newFarm("farm-1"), 0, "The chickenPen isn't bought."],
		["from a pen content doesn't have", withPen(), 1, "There is no pen 2."],
	])("is refused %s", (_name, farm, pen, reason) => {
		expect(sim.apply(farm, { type: "collectProducts", pen }, 0)).toEqual({ ok: false, reason });
	});
});
