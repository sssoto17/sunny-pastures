// The order board: orders drawn from the orders stream (MUST-04; ADR-0005, section 3). #87's later
// parts add refilling, delivering and discarding.
import type { Content, GoodCount, OrderGood } from "../content/index.js";
import { levelOf } from "../progress/index.js";
import type { ProgressRules } from "../progress/index.js";
import { mulberry32 } from "../random/index.js";
import type { FarmState } from "../state/index.js";
import type { StorageRules } from "../storage/index.js";

/** One slot of the board (ADR-0003, section 5: order slots are stored facts). */
export type OrderSlot =
	| { readonly status: "open"; readonly order: Order }
	/**
	 * Refills at `refillAt`, in ms, stored when the slot emptied so a later rules version doesn't
	 * move it (ADR-0006, section 7).
	 */
	| { readonly status: "empty"; readonly refillAt: number };

/** What an order asks for and pays, fixed when it is drawn (MUST-04.2). */
export interface Order {
	/** 1–3 different goods, in the order they were drawn: delivering takes them in this order. */
	readonly goods: readonly GoodCount[];
	readonly coins: number;
	readonly xp: number;
}

/** The order rules for one content, prepared once in createSim. */
export interface OrderRules {
	/** In content order, each with the Level that unlocks it for orders. */
	readonly goods: readonly OrderGoodRule[];
	/** Level 1 first: the board's slots at each Level and its refill delays in ms (D7). */
	readonly levels: readonly BoardLevel[];
	/** What makes each good producible (`GLOSSARY.md`, "Producible"). */
	readonly producers: ReadonlyMap<string, readonly Producer[]>;
	readonly progress: ProgressRules;
	readonly storage: StorageRules;
}

/**
 * Copies what the rules read. Throws a RangeError if Level 1 unlocks no crop for orders: a good a
 * farm can always produce, so every draw has one to ask for (MUST-04.3).
 */
export function prepareOrderRules(
	content: Content,
	progress: ProgressRules,
	storage: StorageRules,
): OrderRules {
	let slots = 0;
	const levels = content.levels.map((row): BoardLevel => {
		slots += row.orderSlots;
		return {
			slots,
			deliveredMs: row.refillSeconds.delivered * 1000,
			discardedMs: row.refillSeconds.discarded * 1000,
		};
	});
	const goods = content.orderGoods.map((good): OrderGoodRule => ({
		...good,
		level: progress.orderGoodLevels.get(good.good) ?? null,
	}));
	const rules = { goods, levels, producers: mapProducers(content, progress), progress, storage };
	if (!goods.some((good) => good.level === 1 && isAlwaysProducible(good.good, rules))) {
		throw new RangeError("Level 1 must unlock a crop that is planted at Level 1 for orders.");
	}

	return rules;
}

/** A new farm's board: the slots of its Level, each with an order drawn in slot order. */
export function fillNewBoard(farm: FarmState, rules: OrderRules): FarmState {
	let current = farm;
	while (current.board.length < countSlots(current, rules)) {
		current = drawInto(current, current.board.length, rules);
	}
	return current;
}

/** An order good with the Level that unlocks it for orders, or null if none does: then no order asks for it. */
type OrderGoodRule = OrderGood & { readonly level: number | null };

interface BoardLevel {
	readonly slots: number;
	readonly deliveredMs: number;
	readonly discardedMs: number;
}

type Producer =
	| { readonly kind: "crop"; readonly level: number }
	| { readonly kind: "facility"; readonly index: number; readonly tier: number }
	| { readonly kind: "pen"; readonly index: number };

/** The most kinds of goods one order asks for (MUST-04.2). */
const mostKinds = 3;

/**
 * Whether the farm can make `good` right now: it has the crop unlocked, the facility at the
 * recipe's tier, or the pen (`GLOSSARY.md`, "Producible"). Derived, never stored (D12). It never
 * goes back within a rules version: Levels, facilities, tiers and pens are never lost.
 */
function isProducible(farm: FarmState, good: string, rules: OrderRules): boolean {
	return (rules.producers.get(good) ?? []).some((producer) => {
		switch (producer.kind) {
			case "crop":
				return levelOf(farm.xp, rules.progress) >= producer.level;
			case "facility":
				return (farm.facilities[producer.index]?.tier ?? 0) >= producer.tier;
			case "pen":
				return (farm.pens[producer.index] ?? null) !== null;
		}
	});
}

/** A crop that no Level unlocks has no producer: it is never producible. */
function mapProducers(
	content: Content,
	progress: ProgressRules,
): ReadonlyMap<string, readonly Producer[]> {
	const crops = Object.keys(content.crops).flatMap((good): [string, Producer][] => {
		const level = progress.cropLevels.get(good);
		return level === undefined ? [] : [[good, { kind: "crop", level }]];
	});
	const recipes = content.facilities.flatMap((facility, index) =>
		Object.values(facility.recipes).map(({ output, tier }): [string, Producer] => [
			output.good,
			{ kind: "facility", index, tier },
		]),
	);
	const pens = content.pens.map((pen, index): [string, Producer] => [
		pen.product,
		{ kind: "pen", index },
	]);
	const producers = new Map<string, Producer[]>();
	for (const [good, producer] of [...crops, ...recipes, ...pens]) {
		producers.set(good, [...(producers.get(good) ?? []), producer]);
	}
	return producers;
}

/** A crop planted from Level 1 is producible on every farm. */
function isAlwaysProducible(good: string, rules: Pick<OrderRules, "producers">): boolean {
	return (rules.producers.get(good) ?? []).some(
		(producer) => producer.kind === "crop" && producer.level === 1,
	);
}

function findLevel(farm: FarmState, rules: OrderRules): BoardLevel {
	const level = rules.levels[levelOf(farm.xp, rules.progress) - 1];
	// levelOf is at least 1 for every farm: Level 1's XP is 0 (MUST-10.4).
	if (level === undefined) {
		throw new RangeError(`The farm's XP of ${String(farm.xp)} has no Level.`);
	}

	return level;
}

function countSlots(farm: FarmState, rules: OrderRules): number {
	return findLevel(farm, rules).slots;
}

/**
 * Draws an order into `index` from the orders stream (D9; MUST-04.2), from the goods unlocked at
 * the farm's Level, in content order: how many kinds, then each good in turn and its amount. While
 * another open order asks for a good the farm can't produce, only producible goods are drawn, so
 * at most one open order does (MUST-04.3). Integers only: a draw modulo a count (D16).
 */
function drawInto(farm: FarmState, index: number, rules: OrderRules): FarmState {
	const level = levelOf(farm.xp, rules.progress);
	const unlocked = rules.goods.filter((good) => good.level !== null && good.level <= level);
	const isStretched = farm.board.some(
		(slot) =>
			slot.status === "open" &&
			slot.order.goods.some(({ good }) => !isProducible(farm, good, rules)),
	);
	const left = isStretched
		? unlocked.filter(({ good }) => isProducible(farm, good, rules))
		: unlocked;

	let stream = farm.streams.orders;
	const roll = (count: number): number => {
		const draw = mulberry32(stream);
		stream = draw.next;
		return draw.value % count;
	};
	const kinds = 1 + roll(Math.min(mostKinds, left.length));
	const picked = Array.from({ length: kinds }, () => {
		const [good] = left.splice(roll(left.length), 1);
		// left holds at least `kinds` goods, so splice always returns one.
		if (good === undefined) throw new RangeError("An order drew from an empty list of goods.");

		return { good, amount: good.min + roll(good.max - good.min + 1) };
	});
	const order: Order = {
		goods: picked.map(({ good, amount }) => ({ good: good.good, amount })),
		coins: picked.reduce((total, { good, amount }) => total + amount * good.coins, 0),
		xp: picked.reduce((total, { good, amount }) => total + amount * good.xp, 0),
	};
	const filled = replaceSlot(farm, index, { status: "open", order });
	return { ...filled, streams: { ...farm.streams, orders: stream } };
}

/** Sets the slot at `index`, or adds it at the end when `index` is the board's length. */
function replaceSlot(farm: FarmState, index: number, slot: OrderSlot): FarmState {
	const board = index === farm.board.length ? [...farm.board, slot] : farm.board;
	return { ...farm, board: board.map((current, i) => (i === index ? slot : current)) };
}
