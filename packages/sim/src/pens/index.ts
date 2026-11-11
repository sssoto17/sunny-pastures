// Pens: buying them, feeding their troughs, the animals producing, and collecting the products
// (MUST-02, MUST-05.6; ADR-0005, section 3; ADR-0003, section 12).
import { assertTime } from "../advance/index.js";
import type { AutomatedStep, StepSource } from "../advance/index.js";
import type { Content } from "../content/index.js";
import { gainXp, purchase } from "../progress/index.js";
import type { ProgressRules } from "../progress/index.js";
import { refuse } from "../state/index.js";
import type { ApplyResult, FarmState } from "../state/index.js";
import { countHeld, put, take } from "../storage/index.js";
import type { StorageRules } from "../storage/index.js";

/** A bought pen (ADR-0003, section 5: pens and troughs are stored facts). */
export interface OwnedPen {
	/** Portions of feed in the trough, from 0 to its capacity. Above 0, no animal is idle. */
	readonly trough: number;
	/** One per animal, in slot order: an animal's slot is its position (MUST-10.6). */
	readonly animals: readonly Animal[];
	/** Products waiting in the pen until collected (MUST-02.4). */
	readonly products: number;
}

/** One animal of a pen. */
export type Animal =
	/** Waiting for feed: it eats the next portion that reaches the trough (MUST-02.3). */
	| { readonly status: "idle" }
	/**
	 * Has eaten a portion and produces as an automated step at `readyAt`, in ms, stored when it
	 * ate so a later rules version doesn't move it (ADR-0006, section 7; MUST-06.7).
	 */
	| { readonly status: "producing"; readonly readyAt: number };

/** The actions on pens (MUST-02). `pen` is an index in content order. */
export type PenAction =
	/** Buys the pen; refused once bought, so an action sent twice buys one pen. */
	| { readonly type: "buyPen"; readonly pen: number }
	/** Moves feed from the barn into the trough, up to its capacity (MUST-02.2). */
	| { readonly type: "feed"; readonly pen: number }
	/** Moves every waiting product to the barn (MUST-02.4). */
	| { readonly type: "collectProducts"; readonly pen: number };

/** The pen rules for one content, prepared once in createSim. */
export interface PenRules {
	/** In content order. */
	readonly pens: readonly PenRule[];
	readonly progress: ProgressRules;
	readonly storage: StorageRules;
}

/** Copies what the rules read: each pen's unlock Level, and its production time in ms (D7). */
export function preparePenRules(
	content: Content,
	progress: ProgressRules,
	storage: StorageRules,
): PenRules {
	const pens = content.pens.map((pen): PenRule => ({
		id: pen.id,
		price: pen.price,
		level: unlockLevel(pen.id, content),
		animals: pen.animals,
		feed: pen.feed,
		troughCapacity: pen.troughCapacity,
		product: pen.product,
		productionMs: pen.seconds * 1000,
		xp: pen.xp,
	}));
	return { pens, progress, storage };
}

/** A new farm's pens: none bought, one entry per content pen (MUST-05.6). */
export function newPens(rules: PenRules): readonly (OwnedPen | null)[] {
	return rules.pens.map(() => null);
}

/**
 * Buys a pen with an empty trough, idle animals and no products, once the farm's Level unlocks
 * it, through the purchase rule (spec decision 1, MUST-05.6).
 */
export function buyPen(farm: FarmState, index: number, rules: PenRules): ApplyResult {
	const rule = findRule(index, rules);
	if (rule === null) return refuse(`There is no pen ${formatPenNumber(index)}.`);
	if ((farm.pens[index] ?? null) !== null) return refuse(`The ${rule.id} is already bought.`);

	const offer = { what: `The ${rule.id}`, level: rule.level, price: rule.price };
	const bought = purchase(farm, offer, rules.progress);
	if (!bought.ok) return bought;

	const animals = Array.from({ length: rule.animals }, () => idle);
	return { ok: true, state: replacePen(bought.state, index, { trough: 0, animals, products: 0 }) };
}

/**
 * Moves feed from the barn into the trough, up to its capacity, and idle animals eat from it at
 * once (MUST-02.2, 02.3). Refused if the trough is full or the barn holds none of its feed.
 */
export function feed(farm: FarmState, index: number, rules: PenRules): ApplyResult {
	const found = findOwned(farm, index, rules);
	if (!found.ok) return found;

	const { rule, pen } = found;
	const room = rule.troughCapacity - pen.trough;
	if (room <= 0) return refuse(`The ${rule.id}'s trough is full.`);

	// As much as fits and the barn holds. With none held, ask for a full trough, so take's
	// refusal names the shortage.
	const inBarn = countHeld(farm, rule.feed, rules.storage);
	const amount = inBarn === 0 ? room : Math.min(room, inBarn);
	const taken = take(farm, [{ good: rule.feed, amount }], `Feeding the ${rule.id}`, rules.storage);
	if (!taken.ok) return taken;

	const filled = { ...pen, trough: pen.trough + amount };
	return { ok: true, state: replacePen(taken.state, index, eat(filled, rule, farm.time)) };
}

/**
 * Moves every waiting product to the barn and gives XP for each, with the level-up coins of any
 * Level it reaches (MUST-02.4, 05.2, 05.4). Refused if there are none or the barn can't hold them.
 */
export function collectProducts(farm: FarmState, index: number, rules: PenRules): ApplyResult {
	const found = findOwned(farm, index, rules);
	if (!found.ok) return found;

	const { rule, pen } = found;
	if (pen.products === 0) return refuse(`The ${rule.id} has nothing to collect.`);

	const goods = { good: rule.product, amount: pen.products };
	const stored = put(farm, goods, `collecting from the ${rule.id}`, rules.storage);
	if (!stored.ok) return stored;

	const collected = replacePen(stored.state, index, { ...pen, products: 0 });
	return { ok: true, state: gainXp(collected, pen.products * rule.xp, rules.progress) };
}

/**
 * Creates the producing source: an animal produces at its `readyAt`, then eats the next portion if
 * the trough holds one (MUST-02.3). A step's index is its pen's and its slot the animal's, so keys
 * stay unique. The next portion's time is read from the rules running at the time the animal
 * produces (ADR-0006, section 4); a portion already eaten keeps its stored time (section 7).
 */
export function createProducing(rules: PenRules): StepSource<FarmState> {
	return {
		steps: (farm) =>
			farm.pens.flatMap((pen, index) =>
				(pen?.animals ?? []).flatMap((animal, slot): AutomatedStep[] =>
					animal.status === "producing"
						? [{ at: animal.readyAt, kind: "produce", index, slot }]
						: [],
				),
			),
		run: (farm, step) => {
			const pen = farm.pens[step.index] ?? null;
			const rule = rules.pens[step.index];
			if (pen?.animals[step.slot]?.status !== "producing" || rule === undefined) return farm;

			const animals = pen.animals.map((animal, slot) => (slot === step.slot ? idle : animal));
			const produced = { ...pen, animals, products: pen.products + 1 };
			return replacePen(farm, step.index, eat(produced, rule, step.at));
		},
	};
}

interface PenRule {
	readonly id: string;
	readonly price: number;
	/** The Level that unlocks it, or null if none does. */
	readonly level: number | null;
	readonly animals: number;
	readonly feed: string;
	readonly troughCapacity: number;
	readonly product: string;
	readonly productionMs: number;
	readonly xp: number;
}

const idle = { status: "idle" } as const;

/**
 * Idle animals eat from the trough at `time`, one portion each, in slot order (MUST-10.6), until
 * it is empty. Each stores when it will produce, read from content now (ADR-0006, section 7).
 */
function eat(pen: OwnedPen, rule: PenRule, time: number): OwnedPen {
	let { trough } = pen;
	const animals = pen.animals.map((animal): Animal => {
		if (animal.status !== "idle" || trough === 0) return animal;

		trough -= 1;
		const readyAt = time + rule.productionMs;
		assertTime(readyAt);
		return { status: "producing", readyAt };
	});
	return { ...pen, trough, animals };
}

/** The first Level that lists the pen, in the table's array order (MUST-10.6). */
function unlockLevel(id: string, content: Content): number | null {
	const i = content.levels.findIndex((level) => level.pens.includes(id));
	return i === -1 ? null : i + 1;
}

function findRule(index: number, rules: PenRules): PenRule | null {
	return Number.isSafeInteger(index) && index >= 0 ? (rules.pens[index] ?? null) : null;
}

/** The pen at `index` and its rule, or a refusal if content has no such pen or it isn't bought. */
function findOwned(
	farm: FarmState,
	index: number,
	rules: PenRules,
): { ok: true; rule: PenRule; pen: OwnedPen } | { ok: false; reason: string } {
	const rule = findRule(index, rules);
	if (rule === null) return { ok: false, reason: `There is no pen ${formatPenNumber(index)}.` };

	const pen = farm.pens[index] ?? null;
	if (pen === null) return { ok: false, reason: `The ${rule.id} isn't bought.` };

	return { ok: true, rule, pen };
}

/** Players count pens from 1. */
function formatPenNumber(index: number): string {
	return String(index + 1);
}

/**
 * Sets the pen at `index`. The farm has one entry per content pen: a version that adds pens adds
 * their entries in its `upgrade` (ADR-0006, section 6).
 */
function replacePen(farm: FarmState, index: number, pen: OwnedPen): FarmState {
	return { ...farm, pens: farm.pens.map((current, i) => (i === index ? pen : current)) };
}
