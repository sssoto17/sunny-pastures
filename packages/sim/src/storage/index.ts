// Storage: the silo and the barn, and putting goods in and taking them out (MUST-06.4; ADR-0005,
// section 3). Harvesting, feeding and collecting from pens share these rules (#86).
import type { Content, GoodCount } from "../content/index.js";
import { refuse } from "../state/index.js";
import type { ApplyResult, FarmState } from "../state/index.js";

/** The storage rules for one content, prepared once in createSim. */
export interface StorageRules {
	readonly siloCapacity: number;
	readonly barnCapacity: number;
	/** The goods the silo holds; the barn holds every other good (MUST-06.4). */
	readonly crops: ReadonlySet<string>;
}

/** Copies what the rules read, so a later change to the content object can't reach them. */
export function prepareStorageRules(content: Content): StorageRules {
	return {
		siloCapacity: content.silo.capacity,
		barnCapacity: content.barn.capacity,
		crops: new Set(Object.keys(content.crops)),
	};
}

/**
 * Puts `goods` in the good's store. Refused if the store can't hold them all; `what` names the
 * cause in the refusal, as the subject of a sentence ("the harvest").
 */
export function put(
	farm: FarmState,
	goods: GoodCount,
	what: string,
	rules: StorageRules,
): ApplyResult {
	const store = storeOf(goods.good, rules);
	const room = capacityOf(store, rules) - sum(farm[store]);
	if (goods.amount > room) {
		const unit = store === "silo" ? "crop" : "good";
		return refuse(
			`The ${store} has room for ${String(room)} more ${unit}${room === 1 ? "" : "s"}, and ${what} needs room for ${String(goods.amount)} ${goods.good}.`,
		);
	}

	return {
		ok: true,
		state: withCount(farm, store, goods.good, countHeld(farm, goods.good, rules) + goods.amount),
	};
}

/**
 * Takes every input from its store, in list order. Refused, naming the first input that is short,
 * unless the farm holds them all; `what` names the cause ("Feeding").
 */
export function take(
	farm: FarmState,
	inputs: readonly GoodCount[],
	what: string,
	rules: StorageRules,
): ApplyResult {
	let current = farm;
	for (const { good, amount } of inputs) {
		const store = storeOf(good, rules);
		const count = countHeld(current, good, rules);
		if (count < amount) {
			return refuse(
				`${what} needs ${String(amount)} ${good}, and the ${store} has ${String(count)}.`,
			);
		}

		current = withCount(current, store, good, count - amount);
	}
	return { ok: true, state: current };
}

/** How many of `good` the farm's store for it holds. */
export function countHeld(farm: FarmState, good: string, rules: StorageRules): number {
	return farm[storeOf(good, rules)][good] ?? 0;
}

type Store = "silo" | "barn";

function storeOf(good: string, rules: StorageRules): Store {
	return rules.crops.has(good) ? "silo" : "barn";
}

function capacityOf(store: Store, rules: StorageRules): number {
	return store === "silo" ? rules.siloCapacity : rules.barnCapacity;
}

/** A store's fill. A sum, so the order of the goods' keys can't matter (MUST-10.6). */
function sum(goods: FarmState[Store]): number {
	return Object.values(goods).reduce((total, count) => total + count, 0);
}

/** A good has a key only while its count is above 0, so equal farms hash equally (state/). */
function withCount(farm: FarmState, store: Store, good: string, count: number): FarmState {
	const others = Object.entries(farm[store]).filter(([key]) => key !== good);
	const goods = Object.fromEntries(count > 0 ? [...others, [good, count]] : others);
	return { ...farm, [store]: goods };
}
