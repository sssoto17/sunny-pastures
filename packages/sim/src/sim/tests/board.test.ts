import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { Content, FarmState, Order, OrderSlot } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";
import { expectDrawn } from "./expectDrawn.js";
import { plantWheat } from "./plantWheat.js";

const sim = createSim(sliceContent);
// The slice's order board (#87's "Decided by the lane"), written out rather than read from content.
const level2 = 10;
const growMs = 120_000;

const wheatOrder = (amount: number): Order => ({
	goods: [{ good: "wheat", amount }],
	coins: amount * 3,
	xp: amount,
});
const open = (order: Order): OrderSlot => ({ status: "open", order });
const refillAt = (at: number): OrderSlot => ({ status: "empty", refillAt: at });

/** The open orders of a board. */
const listOrders = (farm: FarmState): Order[] =>
	farm.board.flatMap((slot) => (slot.status === "open" ? [slot.order] : []));

/** Orders that ask for a good other than wheat: the only good a new farm can produce. */
const countStretched = (farm: FarmState): number =>
	listOrders(farm).filter((order) => order.goods.some(({ good }) => good !== "wheat")).length;

/** Test content whose Level 1 unlocks every order good and gives the board five slots. */
const allAtOnce: Content = {
	...sliceContent,
	levels: sliceContent.levels.map((level, i) =>
		i === 0
			? { ...level, orderSlots: 5, orderGoods: ["wheat", "chickenFeed", "egg", "bread"] }
			: { ...level, orderGoods: [] },
	),
};
/** A Level 2 farm with no feed mill or pen, its four slots refilling at `at`. */
const refillingAtLevel2 = (id: string, at: number): FarmState => ({
	...sim.newFarm(id),
	xp: level2,
	board: Array.from({ length: 4 }, () => refillAt(at)),
});

const newFarms = (content: Content): FarmState[] => {
	const contentSim = createSim(content);
	return Array.from({ length: 40 }, (_farm, i) => contentSim.newFarm(`farm-${String(i)}`));
};

describe("a new farm's order board", () => {
	it("opens Level 1's three slots with wheat orders drawn from the orders stream (MUST-04.1, 04.2)", () => {
		// farm-1's draws, recorded once: every Level 1 order asks for wheat, the one good it unlocks.
		expect(sim.newFarm("farm-1").board).toEqual([
			open(wheatOrder(6)),
			open(wheatOrder(5)),
			open(wheatOrder(5)),
		]);
	});

	it("is the same for the same farm id, and differs between ids (MUST-04.2, 10.3)", () => {
		const boards = ["a", "b", "c", "d"].map((id) => JSON.stringify(sim.newFarm(id).board));

		expect(createSim(sliceContent).newFarm("a").board).toEqual(sim.newFarm("a").board);
		expect(new Set(boards).size).toBeGreaterThan(1);
	});
});

describe("drawing an order", () => {
	it("asks for 1–3 different unlocked goods in set amounts, and pays coins and XP for each (MUST-04.2)", () => {
		const orders = newFarms(allAtOnce).flatMap(listOrders);

		expect(orders).toHaveLength(5 * 40);
		for (const order of orders) expectDrawn(order, 3);
		// Every unlocked good appears, and so do orders of one, two and three kinds.
		const drawn = new Set(orders.flatMap((order) => order.goods.map(({ good }) => good)));
		expect([...drawn].sort()).toEqual(["bread", "chickenFeed", "egg", "wheat"]);
		expect(new Set(orders.map((order) => order.goods.length))).toEqual(new Set([1, 2, 3]));
	});

	it("draws goods in content order, pinned for a Level with several goods (MUST-04.2, 10.6)", () => {
		// farm-1's board under test content that unlocks all four goods, recorded once. Picking by
		// sorted id or object key order instead of `orderGoods`' array order changes it.
		const { board } = createSim(allAtOnce).newFarm("farm-1");
		const order = (goods: [string, number][], coins: number, xp: number): OrderSlot =>
			open({ goods: goods.map(([good, amount]) => ({ good, amount })), coins, xp });

		expect(board).toEqual([
			order(
				[
					["wheat", 6],
					["bread", 1],
					["egg", 1],
				],
				41,
				12,
			),
			open(wheatOrder(3)),
			open(wheatOrder(3)),
			open(wheatOrder(2)),
			open(wheatOrder(2)),
		]);
		const reversed = { ...allAtOnce, orderGoods: [...allAtOnce.orderGoods].reverse() };
		expect(createSim(reversed).newFarm("farm-1").board).not.toEqual(board);
	});

	it("lets at most one open order ask for a good the farm can't produce (MUST-04.3)", () => {
		// A new farm has no facility or pen, so only wheat is producible.
		expect(Math.max(...newFarms(allAtOnce).map(countStretched))).toBe(1);
	});
});

describe("refilling an order", () => {
	it("lets at most one open order ask for a good the farm can't produce at Level 2 (MUST-04.3)", () => {
		const counts = Array.from({ length: 40 }, (_farm, i) =>
			countStretched(sim.advance(refillingAtLevel2(`farm-${String(i)}`, 1_000), 1_000)),
		);

		expect(Math.max(...counts)).toBe(1);
	});

	it("asks freely for goods the farm can produce: with the feed mill and pen bought (MUST-04.3)", () => {
		const idle = { status: "idle" } as const;
		const counts = Array.from({ length: 40 }, (_farm, i) => {
			const farm = refillingAtLevel2(`farm-${String(i)}`, 1_000);
			const pen = { trough: 0, animals: [idle, idle, idle], products: 0 };
			const owned = { ...farm, facilities: [{ tier: 1, jobs: [] }, null], pens: [pen] };
			return countStretched(sim.advance(owned, 1_000));
		});

		expect(Math.max(...counts)).toBeGreaterThan(1);
	});

	it("draws from the orders stream, never the yields stream (D9)", () => {
		const farm = refillingAtLevel2("farm-1", 1_000);

		expect(sim.advance(farm, 1_000).streams.yields).toBe(farm.streams.yields);
		expect(sim.advance(farm, 1_000).streams.orders).not.toBe(farm.streams.orders);
	});
});

describe("a slot refilling", () => {
	it("draws a new order exactly at its stored time, not a ms before (MUST-04.5, 04.6)", () => {
		const [, ...rest] = sim.newFarm("farm-1").board;
		const farm = { ...sim.newFarm("farm-1"), board: [refillAt(5_000), ...rest] };

		expect(sim.advance(farm, 4_999).board[0]).toEqual(refillAt(5_000));
		expect(sim.advance(farm, 5_000).board[0]?.status).toBe("open");
		expect(sim.advance(farm, 5_000).board.slice(1)).toEqual(rest);
	});

	it("happens while the player is away: one advance refills every slot that is due (MUST-04.6)", () => {
		const board = [refillAt(3_000), refillAt(1_000), refillAt(2_000)];
		const later = sim.advance({ ...sim.newFarm("farm-1"), board }, 86_400_000);

		expect(later.board.every((slot) => slot.status === "open")).toBe(true);
	});

	it("draws slots due at the same time in slot order (MUST-10.6)", () => {
		const together = {
			...sim.newFarm("farm-1"),
			board: [refillAt(1_000), refillAt(1_000), refillAt(1_000)],
		};
		const apart = { ...together, board: [refillAt(1_000), refillAt(1_001), refillAt(1_002)] };

		expect(sim.advance(together, 2_000).board).toEqual(sim.advance(apart, 2_000).board);
	});
});

describe("the board growing with the Level", () => {
	it("adds Level 2's slot when a harvest reaches it, with an order drawn at once (MUST-04.1)", () => {
		const nearly = { ...plantWheat(sim, "farm-1"), xp: level2 - 1 };
		const farm = expectAccepted(sim.apply(nearly, { type: "harvest", plot: 0 }, growMs));

		expect(farm.board).toHaveLength(4);
		expect(farm.board.slice(0, 3)).toEqual(nearly.board);
		expect(farm.board[3]?.status).toBe("open");
		expect(sim.advance(farm, growMs)).toBe(farm);
	});

	it("adds every slot of the Levels one gain crosses, never more than content gives (MUST-04.1)", () => {
		const nearly = { ...plantWheat(sim, "farm-1"), xp: 99 };
		const farm = expectAccepted(sim.apply(nearly, { type: "harvest", plot: 0 }, growMs));

		expect(farm.board).toHaveLength(7);
		expect(farm.board.every((slot) => slot.status === "open")).toBe(true);
	});
});

describe("createSim", () => {
	it("throws a RangeError for content whose Level 1 unlocks no plantable crop for orders", () => {
		const [level1, ...rest] = sliceContent.levels;
		const content: Content = { ...sliceContent, levels: [{ ...level1, orderGoods: [] }, ...rest] };

		expect(() => createSim(content)).toThrow(RangeError);
	});
});
