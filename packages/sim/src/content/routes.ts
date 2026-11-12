// When each good becomes producible (`GLOSSARY.md`, "Producible"), read from the Level table: the
// content check's least fixed point (ADR-0003, section 17).
import type { Content, Facility, Recipe } from "./index.js";
import { findUnlockLevel, formatTierId, mapListings } from "./unlocks.js";

/** The Levels content unlocks things at, by the first listing (`progress/`). */
export interface UnlockLevels {
	readonly crop: (id: string) => number | null;
	readonly pen: (id: string) => number | null;
	/** The Level a recipe can first be made at: its facility's, or its tier's if later. */
	readonly recipe: (facility: Facility, recipe: Recipe) => number | null;
}

export function readUnlockLevels(content: Content): UnlockLevels {
	const crops = mapListings(content, "crops");
	const facilities = mapListings(content, "facilities");
	const pens = mapListings(content, "pens");
	const tiers = mapListings(content, "tiers");
	return {
		crop: (id) => findUnlockLevel(crops, id),
		pen: (id) => findUnlockLevel(pens, id),
		recipe: (facility, recipe) => {
			const level = findUnlockLevel(facilities, facility.id);
			const tier =
				recipe.tier <= 1 ? level : findUnlockLevel(tiers, formatTierId(facility.id, recipe.tier));
			return level === null || tier === null ? null : Math.max(level, tier);
		},
	};
}

/**
 * The earliest Level at which each good is producible by some route: a crop at its unlock; a
 * recipe's output once the recipe is unlocked and every input is producible; a pen's product once
 * the pen is unlocked and its feed is producible. Levels only fall from "never" as routes are
 * found, so the loop ends; a good only a cycle makes, with no route into it, never gets a Level.
 * The result doesn't depend on the order routes are tried in (MUST-10.6).
 */
export function mapEarliestLevels(
	content: Content,
	unlocks: UnlockLevels,
): ReadonlyMap<string, number> {
	const earliest = new Map<string, number>();
	const offer = (good: string, level: number | null, inputs: readonly string[]): boolean => {
		const levels = inputs.map((input) => earliest.get(input));
		if (level === null || levels.includes(undefined)) return false;

		const at = Math.max(level, ...levels.map((input) => input ?? level));
		const known = earliest.get(good);
		if (known !== undefined && known <= at) return false;

		earliest.set(good, at);
		return true;
	};
	for (const id of Object.keys(content.crops)) offer(id, unlocks.crop(id), []);
	let hasChanged = true;
	while (hasChanged) {
		const offers = [
			...content.facilities.flatMap((facility) =>
				Object.values(facility.recipes).map((recipe) =>
					offer(
						recipe.output.good,
						unlocks.recipe(facility, recipe),
						recipe.inputs.map(({ good }) => good),
					),
				),
			),
			...content.pens.map((pen) => offer(pen.product, unlocks.pen(pen.id), [pen.feed])),
		];
		hasChanged = offers.includes(true);
	}
	return earliest;
}
