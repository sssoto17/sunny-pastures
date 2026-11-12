import type { Order } from "../../index.js";

/**
 * The slice's order goods (#87's "Decided by the lane"), written out rather than read from content:
 * the Level that unlocks each for orders, the fewest and most an order asks for, and the coins and
 * XP each one pays.
 */
export const orderTerms = new Map([
	["wheat", { level: 1, min: 2, max: 6, coins: 3, xp: 1 }],
	["chickenFeed", { level: 2, min: 2, max: 4, coins: 4, xp: 1 }],
	["egg", { level: 2, min: 1, max: 3, coins: 8, xp: 2 }],
	["bread", { level: 3, min: 1, max: 2, coins: 15, xp: 4 }],
]);

/**
 * What is wrong with an order drawn at `level`, as sentences, or none (MUST-04.2): it must ask for
 * 1–3 different goods unlocked for orders at that Level, each in its set amounts, and pay the
 * coins and XP of the goods asked for. Plain checks, so the property harness can run it on every
 * order of every farm at the cost of one `expect` a farm.
 */
export function listDrawFaults(order: Order, level: number): string[] {
	const faults: string[] = [];
	const goods = order.goods.map(({ good }) => good);
	if (goods.length < 1 || goods.length > 3) faults.push(`asks for ${String(goods.length)} goods`);
	if (new Set(goods).size !== goods.length) faults.push("asks for a good twice");
	let [coins, xp] = [0, 0];
	for (const { good, amount } of order.goods) {
		const term = orderTerms.get(good);
		if (term === undefined || term.level > level) {
			faults.push(`asks for ${good}, not unlocked at Level ${String(level)}`);
			continue;
		}

		if (amount < term.min || amount > term.max) faults.push(`asks for ${String(amount)} ${good}`);
		coins += amount * term.coins;
		xp += amount * term.xp;
	}
	if (order.coins !== coins || order.xp !== xp) faults.push("pays the wrong coins or XP");
	return faults;
}
