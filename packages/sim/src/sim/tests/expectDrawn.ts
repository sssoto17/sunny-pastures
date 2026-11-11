import { expect } from "vitest";

import type { Order } from "../../index.js";

// The slice's order goods (#87's "Decided by the lane"), written out rather than read from content:
// the Level that unlocks each for orders, the fewest and most an order asks for, and the coins and
// XP each one pays.
const orderTerms = new Map([
	["wheat", { level: 1, min: 2, max: 6, coins: 3, xp: 1 }],
	["chickenFeed", { level: 2, min: 2, max: 4, coins: 4, xp: 1 }],
	["egg", { level: 2, min: 1, max: 3, coins: 8, xp: 2 }],
	["bread", { level: 3, min: 1, max: 2, coins: 15, xp: 4 }],
]);

/**
 * Checks an order drawn at `level`: 1–3 different goods unlocked for orders at it, each in its set
 * amounts, paying the coins and XP of the goods asked for (MUST-04.2).
 */
export function expectDrawn(order: Order, level: number): void {
	expect(order.goods.length).toBeGreaterThanOrEqual(1);
	expect(order.goods.length).toBeLessThanOrEqual(3);
	expect(new Set(order.goods.map(({ good }) => good)).size).toBe(order.goods.length);
	let [coins, xp] = [0, 0];
	for (const { good, amount } of order.goods) {
		const term = orderTerms.get(good);
		expect(term?.level).toBeLessThanOrEqual(level);
		expect(amount).toBeGreaterThanOrEqual(term?.min ?? NaN);
		expect(amount).toBeLessThanOrEqual(term?.max ?? NaN);
		coins += amount * (term?.coins ?? NaN);
		xp += amount * (term?.xp ?? NaN);
	}
	expect([order.coins, order.xp]).toEqual([coins, xp]);
}
