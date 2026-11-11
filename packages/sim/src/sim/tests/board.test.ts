import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { Content, FarmState, Order, OrderSlot } from "../../index.js";

const sim = createSim(sliceContent);
// The slice's order board (#87's "Decided by the lane"), written out rather than read from content.
/** What each good may be asked for, at the Level that unlocks it for orders. */
const terms = new Map([
	["wheat", { level: 1, min: 2, max: 6, coins: 3, xp: 1 }],
	["chickenFeed", { level: 2, min: 2, max: 4, coins: 4, xp: 1 }],
	["egg", { level: 2, min: 1, max: 3, coins: 8, xp: 2 }],
	["bread", { level: 3, min: 1, max: 2, coins: 15, xp: 4 }],
]);

const wheatOrder = (amount: number): Order => ({
	goods: [{ good: "wheat", amount }],
	coins: amount * 3,
	xp: amount,
});
const open = (order: Order): OrderSlot => ({ status: "open", order });

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
		for (const order of orders) {
			const goods = order.goods.map(({ good }) => good);
			expect(goods.length).toBeGreaterThanOrEqual(1);
			expect(goods.length).toBeLessThanOrEqual(3);
			expect(new Set(goods).size).toBe(goods.length);
			let [coins, xp] = [0, 0];
			for (const { good, amount } of order.goods) {
				const term = terms.get(good);
				expect(term?.level).toBeLessThanOrEqual(3);
				expect(amount).toBeGreaterThanOrEqual(term?.min ?? NaN);
				expect(amount).toBeLessThanOrEqual(term?.max ?? NaN);
				coins += amount * (term?.coins ?? NaN);
				xp += amount * (term?.xp ?? NaN);
			}
			expect([order.coins, order.xp]).toEqual([coins, xp]);
		}
		// Every unlocked good appears, and so do orders of one, two and three kinds.
		const drawn = new Set(orders.flatMap((order) => order.goods.map(({ good }) => good)));
		expect([...drawn].sort()).toEqual(["bread", "chickenFeed", "egg", "wheat"]);
		expect(new Set(orders.map((order) => order.goods.length))).toEqual(new Set([1, 2, 3]));
	});

	it("lets at most one open order ask for a good the farm can't produce (MUST-04.3)", () => {
		// A new farm has no facility or pen, so only wheat is producible.
		expect(Math.max(...newFarms(allAtOnce).map(countStretched))).toBe(1);
	});
});

describe("createSim", () => {
	it("throws a RangeError for content whose Level 1 unlocks no plantable crop for orders", () => {
		const [level1, ...rest] = sliceContent.levels;
		const content: Content = { ...sliceContent, levels: [{ ...level1, orderGoods: [] }, ...rest] };

		expect(() => createSim(content)).toThrow(RangeError);
	});
});
