// What the Level table lists and what content defines, per unlock list (MUST-05.5): the content
// check's shared reads (ADR-0003, section 17). Built from arrays in content order; object keys only
// name ids and never decide an order that matters (MUST-10.6).
import type { Content, LevelRow } from "./index.js";

/** The unlock lists of a Level-table row (`LevelRow`). */
export type UnlockKind = "crops" | "facilities" | "pens" | "tiers" | "addOns" | "orderGoods";

export const unlockKinds: readonly UnlockKind[] = [
	"crops",
	"facilities",
	"pens",
	"tiers",
	"addOns",
	"orderGoods",
];

/** One place an id appears: a Level's listing, or the content entry that defines it. */
export interface Entry {
	readonly id: string;
	readonly path: string;
	/** What the content holds at `path`, for the failure message. */
	readonly value: unknown;
}

/** A Level's listing of an id, Level 1 first (row i is Level i + 1). */
export interface Listing extends Entry {
	readonly level: number;
}

/** Every listing of each id of `kind`, in Level order: the first one unlocks it (`progress/`). */
export function mapListings(
	content: Content,
	kind: UnlockKind,
): ReadonlyMap<string, readonly Listing[]> {
	const listings = new Map<string, Listing[]>();
	content.levels.forEach((row, i) => {
		listEntries(row, kind).forEach(({ id, value }, j) => {
			const listing = {
				id,
				value,
				level: i + 1,
				path: `levels[${String(i)}].${kind}[${String(j)}]`,
			};
			listings.set(id, [...(listings.get(id) ?? []), listing]);
		});
	});
	return listings;
}

/** The Level that unlocks `id`, the first that lists it, or null if none does. */
export function findUnlockLevel(
	listings: ReadonlyMap<string, readonly Listing[]>,
	id: string,
): number | null {
	return listings.get(id)?.[0]?.level ?? null;
}

/** Every id of `kind` that content defines, each where it is defined. */
export function listDefined(content: Content, kind: UnlockKind): readonly Entry[] {
	switch (kind) {
		case "crops":
			return Object.keys(content.crops).map((id) => ({
				id,
				path: `crops.${id}`,
				value: id,
			}));
		case "facilities":
			return content.facilities.map(({ id }, i) => ({
				id,
				path: `facilities[${String(i)}]`,
				value: id,
			}));
		case "pens":
			return content.pens.map(({ id }, i) => ({
				id,
				path: `pens[${String(i)}]`,
				value: id,
			}));
		case "tiers":
			return content.facilities.flatMap((facility, i) =>
				facility.tiers.map((_row, j) => ({
					id: formatTierId(facility.id, j + 2),
					path: `facilities[${String(i)}].tiers[${String(j)}]`,
					value: { facility: facility.id, tier: j + 2 },
				})),
			);
		case "addOns":
			return Object.keys(content.addOns).map((id) => ({
				id,
				path: `addOns.${id}`,
				value: id,
			}));
		case "orderGoods":
			return content.orderGoods.map(({ good }, i) => ({
				id: good,
				path: `orderGoods[${String(i)}]`,
				value: good,
			}));
	}
}

/** One id per facility tier: JSON quotes the facility id, so no two tiers share one. */
export function formatTierId(facility: string, tier: number): string {
	return JSON.stringify([facility, tier]);
}

function listEntries(row: LevelRow, kind: UnlockKind): readonly Omit<Entry, "path">[] {
	if (kind === "tiers") {
		return row.tiers.map((tier) => ({
			id: formatTierId(tier.facility, tier.tier),
			value: tier,
		}));
	}

	return row[kind].map((id) => ({ id, value: id }));
}
