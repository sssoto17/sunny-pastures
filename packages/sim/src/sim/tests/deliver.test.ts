import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { Content, FarmState, Order, OrderSlot } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";

const sim = createSim(sliceContent);
// The slice's refill delays (#87's "Decided by the lane"), written out rather than read from content.
const deliveredMs = [120_000, 120_000, 90_000, 90_000, 60_000] as const;
const discardedMs = [300_000, 300_000, 240_000, 240_000, 180_000] as const;
const levelXp = [0, 10, 30, 60, 100];

const breadAndEggs: Order = {
	goods: [
		{ good: "bread", amount: 2 },
		{ good: "egg", amount: 1 },
	],
	coins: 38,
	xp: 10,
};
const open = (order: Order): OrderSlot => ({ status: "open", order });

/** A Level 1 farm at 1 s with `order` in slot 2, wheat orders around it, and `barn` stored. */
const withOrder = (order: Order, barn: FarmState["barn"], xp = 0): FarmState => {
	const farm = sim.newFarm("farm-1");
	const [first, , third] = farm.board;
	return {
		...farm,
		time: 1_000,
		xp,
		barn,
		board: [first, open(order), third].flatMap((slot) => (slot === undefined ? [] : [slot])),
	};
};

const deliver = { type: "deliver", slot: 1 } as const;
const discard = { type: "discard", slot: 1 } as const;

describe("delivering an order", () => {
	it("takes all its goods, pays its coins and XP, and empties its slot until the delivered delay (MUST-04.4, 04.5)", () => {
		const farm = withOrder(breadAndEggs, { bread: 3, egg: 1, chickenFeed: 2 });
		const delivered = expectAccepted(sim.apply(farm, deliver, 5_000));

		expect(delivered.barn).toEqual({ bread: 1, chickenFeed: 2 });
		// Its 10 XP reaches Level 2, which pays 20 level-up coins on top of the order's 38.
		expect(delivered.coins).toBe(farm.coins + 38 + 20);
		expect(delivered.xp).toBe(10);
		expect(delivered.board[1]).toEqual({ status: "empty", refillAt: 5_000 + deliveredMs[1] });
		expect([delivered.board[0], delivered.board[2]]).toEqual([farm.board[0], farm.board[2]]);
	});

	it("takes crops from the silo", () => {
		const wheat: Order = { goods: [{ good: "wheat", amount: 4 }], coins: 12, xp: 4 };
		const farm = { ...withOrder(wheat, {}), silo: { wheat: 4 } };

		expect(expectAccepted(sim.apply(farm, deliver, 1_000)).silo).toEqual({});
	});

	it("pays the level-up coins of the Levels its XP reaches, and opens their slots (MUST-05.4, 04.1)", () => {
		const farm = withOrder(breadAndEggs, { bread: 2, egg: 1 }, 25);
		const delivered = expectAccepted(sim.apply(farm, deliver, 1_000));

		// 25 + 10 XP reaches Level 3 (30 XP): its 30 coins, and the slots of Levels 2 and 3.
		expect(delivered.coins).toBe(farm.coins + 38 + 30);
		expect(delivered.board).toHaveLength(5);
		expect(delivered.board[1]).toEqual({ status: "empty", refillAt: 1_000 + deliveredMs[2] });
		expect(delivered.board.slice(3).every((slot) => slot.status === "open")).toBe(true);
	});

	it.each([
		["a good is short", { bread: 2 }, "Delivering order 2 needs 1 egg, and the barn has 0."],
		[
			"the first good is short",
			{ bread: 1, egg: 1 },
			"Delivering order 2 needs 2 bread, and the barn has 1.",
		],
	])("is refused, taking nothing, when %s (spec decision 2)", (_name, barn, reason) => {
		expect(sim.apply(withOrder(breadAndEggs, barn), deliver, 1_000)).toEqual({ ok: false, reason });
	});

	it.each([
		[{ type: "deliver", slot: 3 } as const, "There is no order slot 4."],
		[{ type: "deliver", slot: -1 } as const, "There is no such order slot."],
		[{ type: "deliver", slot: 0.5 } as const, "There is no such order slot."],
		[{ type: "discard", slot: 9 } as const, "There is no order slot 10."],
	])("is refused for a slot the board doesn't have: %o", (action, reason) => {
		expect(sim.apply(withOrder(breadAndEggs, {}), action, 1_000)).toEqual({ ok: false, reason });
	});

	it("is refused for an empty slot, so a delivery sent twice delivers once", () => {
		const farm = withOrder(breadAndEggs, { bread: 4, egg: 2 });
		const delivered = expectAccepted(sim.apply(farm, deliver, 1_000));

		expect(sim.apply(delivered, deliver, 1_000)).toEqual({
			ok: false,
			reason: "Order slot 2 is empty.",
		});
		expect(sim.apply(delivered, discard, 1_000)).toEqual({
			ok: false,
			reason: "Order slot 2 is empty.",
		});
	});
});

/**
 * The waits, in ms, of a slot delivered and of one discarded at `level`, measured through the sim
 * with an order that pays no XP, so the delivery stays at `level`.
 */
const measureWaits = (level: number): [number, number] => {
	const xp = levelXp[level - 1] ?? NaN;
	const free: Order = { goods: [{ good: "bread", amount: 1 }], coins: 0, xp: 0 };
	const farm = sim.advance({ ...withOrder(free, { bread: 1 }), xp }, 1_000);
	const [delivered, discarded] = [deliver, discard].map((action) => {
		const slot = expectAccepted(sim.apply(farm, action, 1_000)).board[1];
		return slot?.status === "empty" ? slot.refillAt - 1_000 : NaN;
	});
	return [delivered ?? NaN, discarded ?? NaN];
};

describe("discarding an order", () => {
	it("empties its slot until the discarded delay, taking and paying nothing (MUST-04.4, 04.5)", () => {
		const farm = withOrder(breadAndEggs, { bread: 2, egg: 1 });
		const discarded = expectAccepted(sim.apply(farm, discard, 2_000));

		expect(discarded).toEqual({
			...farm,
			time: 2_000,
			board: [farm.board[0], { status: "empty", refillAt: 2_000 + discardedMs[0] }, farm.board[2]],
		});
	});

	it.each([1, 2, 3, 4, 5])(
		"waits longer than a delivered slot at Level %i, and neither delay grows with the Level (MUST-04.5)",
		(level) => {
			const xp = levelXp[level - 1] ?? NaN;
			const farm = sim.advance({ ...withOrder(breadAndEggs, { bread: 2, egg: 1 }), xp }, 1_000);
			const delivered = expectAccepted(sim.apply(farm, deliver, 1_000)).board[1];
			const discarded = expectAccepted(sim.apply(farm, discard, 1_000)).board[1];
			// Delivering's 10 XP can reach the next Level, whose delay then applies.
			const after = levelXp.filter((threshold) => threshold <= xp + 10).length;

			expect(delivered).toEqual({
				status: "empty",
				refillAt: 1_000 + (deliveredMs[after - 1] ?? NaN),
			});
			expect(discarded).toEqual({
				status: "empty",
				refillAt: 1_000 + (discardedMs[level - 1] ?? NaN),
			});
			expect(discardedMs[level - 1]).toBeGreaterThan(deliveredMs[level - 1] ?? NaN);
			const [delivers, discards] = measureWaits(level);
			expect(discards).toBeGreaterThan(delivers);
			if (level > 1) {
				const [deliveredBelow, discardedBelow] = measureWaits(level - 1);
				expect(delivers).toBeLessThanOrEqual(deliveredBelow);
				expect(discards).toBeLessThanOrEqual(discardedBelow);
			}
		},
	);
});

describe("an emptied slot's refill time", () => {
	it("stays as stored when a later rules version changes the delays (ADR-0006, section 7)", () => {
		const discarded = expectAccepted(sim.apply(withOrder(breadAndEggs, {}), discard, 1_000));
		const quicker: Content = {
			...sliceContent,
			levels: sliceContent.levels.map((level) => ({
				...level,
				refillSeconds: { delivered: 10, discarded: 20 },
			})),
		};
		const next = createSim(quicker);
		const refillAt = 1_000 + discardedMs[0];

		expect(next.advance(discarded, refillAt - 1).board[1]).toEqual({ status: "empty", refillAt });
		expect(next.advance(discarded, refillAt).board[1]?.status).toBe("open");
	});
});
