// Storage: the silo and the barn, and putting goods in and taking them out (MUST-06.4; ADR-0005,
// section 3). Harvesting, starting jobs and collecting them share these rules (#84).
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
	const store = findStore(goods.good, rules);
	const room = findCapacity(store, rules) - sumGoods(farm[store]);
	if (goods.amount > room) {
		const unit = store === "silo" ? "crop" : "good";
		return refuse(
			`The ${store} has room for ${String(room)} more ${unit}${room === 1 ? "" : "s"}, and ${what} needs room for ${String(goods.amount)} ${goods.good}.`,
		);
	}

	return {
		ok: true,
		state: setCount(farm, store, goods.good, countHeld(farm, store, goods.good) + goods.amount),
	};
}

/**
 * Takes every input from its store, in list order. Refused, naming the first input that is short,
 * unless the farm holds them all; `what` names the cause ("Making bread").
 */
export function take(
	farm: FarmState,
	inputs: readonly GoodCount[],
	what: string,
	rules: StorageRules,
): ApplyResult {
	let current = farm;
	for (const { good, amount } of inputs) {
		const store = findStore(good, rules);
		const held = countHeld(current, store, good);
		if (held < amount) {
			return refuse(
				`${what} needs ${String(amount)} ${good}, and the ${store} has ${String(held)}.`,
			);
		}

		current = setCount(current, store, good, held - amount);
	}
	return { ok: true, state: current };
}

type Store = "silo" | "barn";

function findStore(good: string, rules: StorageRules): Store {
	return rules.crops.has(good) ? "silo" : "barn";
}

function findCapacity(store: Store, rules: StorageRules): number {
	return store === "silo" ? rules.siloCapacity : rules.barnCapacity;
}

function countHeld(farm: FarmState, store: Store, good: string): number {
	return farm[store][good] ?? 0;
}

/** A store's fill. A sum, so the order of the goods' keys can't matter (MUST-10.6). */
function sumGoods(goods: FarmState[Store]): number {
	return Object.values(goods).reduce((total, held) => total + held, 0);
}

/** A good has a key only while its count is above 0, so equal farms hash equally (state/). */
function setCount(farm: FarmState, store: Store, good: string, held: number): FarmState {
	const others = Object.entries(farm[store]).filter(([key]) => key !== good);
	const goods = Object.fromEntries(held > 0 ? [...others, [good, held]] : others);
	return { ...farm, [store]: goods };
}
