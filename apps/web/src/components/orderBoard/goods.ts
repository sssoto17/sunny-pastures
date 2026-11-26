import { sliceContent, type GoodCount, type Order, type OrderSlot } from "@sunny-pastures/sim";

import type { FarmStorage } from "@/client/store";

// What the board says about an order's goods, from the predicted farm's storage. Derived on every
// render, never stored (ADR-0010, section 4).

/** One good of an order, with how many the farm holds now. */
export interface GoodNeed extends GoodCount {
	readonly have: number;
}

/**
 * The order's goods in its own order, each with the farm's count of it in the good's own store, as
 * the sim's `take` reads it: a crop from the silo, any other good from the barn (MUST-06.4).
 */
export function listNeeds(order: Order, storage: FarmStorage): readonly GoodNeed[] {
	return order.goods.map((good) => {
		const store = Object.hasOwn(sliceContent.crops, good.good) ? storage.silo : storage.barn;
		return { ...good, have: store.goods[good.good] ?? 0 };
	});
}

/**
 * How many open orders the farm holds every good for: the ones `deliver` would accept, since the
 * sim refuses a delivery only when a good is short (MUST-04.4).
 */
export function countDeliverable(board: readonly OrderSlot[], storage: FarmStorage | null): number {
	if (storage === null) return 0;

	return board.filter(
		(slot) => slot.status === "open" && findShortfall(listNeeds(slot.order, storage)) === null,
	).length;
}

/** Why the order can't be delivered, as a sentence a player reads; null when it can. */
export function findShortfall(needs: readonly GoodNeed[]): string | null {
	const missing = needs.flatMap((need) => {
		const short = need.amount - need.have;
		return short > 0 ? [`${String(short)} more ${nameGood(need.good, short)}`] : [];
	});
	if (missing.length === 0) return null;

	return `You need ${joinWords(missing)} to deliver this order.`;
}

/** A good's name for `count` of it, in lower case; an id with no name reads as itself. */
export function nameGood(good: string, count: number): string {
	if (!isNamed(good)) return good;

	const name = goodNames[good];
	return count === 1 ? name.one : name.other;
}

/**
 * The time until `at` from `now`, rounded up to the second, as "4 min 59 s"; never below 0 s. A
 * whole minute or hour drops its zero parts ("5 min", "1 h").
 */
export function formatTimeLeft(at: number, now: number): string {
	const seconds = Math.max(0, Math.ceil((at - now) / 1000));
	const parts = [
		[Math.floor(seconds / 3600), "h"],
		[Math.floor((seconds % 3600) / 60), "min"],
		[seconds % 60, "s"],
	] as const;
	const shown = parts
		.filter(([value]) => value > 0)
		.map(([value, unit]) => `${String(value)} ${unit}`);
	return shown.length === 0 ? "0 s" : shown.join(" ");
}

/** The slice's goods (`sliceContent`); content holds ids only, so the names live with the copy. */
const goodNames = {
	wheat: { one: "wheat", other: "wheat" },
	chickenFeed: { one: "chicken feed", other: "chicken feed" },
	egg: { one: "egg", other: "eggs" },
	bread: { one: "bread", other: "bread" },
	cookies: { one: "cookies", other: "cookies" },
} as const satisfies Record<string, { readonly one: string; readonly other: string }>;

function isNamed(good: string): good is keyof typeof goodNames {
	return Object.hasOwn(goodNames, good);
}

function joinWords(words: readonly string[]): string {
	if (words.length <= 1) return words.join("");

	return `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;
}
