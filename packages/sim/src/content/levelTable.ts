// The content check's rules on the Level table's unlock lists (MUST-05.5, 10.4; ADR-0003,
// section 17).
import { fail } from "./failure.js";
import type { Content, ContentFailure } from "./index.js";
import { listDefined, mapListings, unlockKinds } from "./unlocks.js";

/**
 * R32, added by #89: facility ids, pen ids and order goods are each defined once. The rules look
 * them up by id (`progress/`, `orders/`), so a second entry with the same id is ambiguous.
 */
export function checkUniqueIds(content: Content): ContentFailure[] {
	return (["facilities", "pens", "orderGoods"] as const).flatMap((kind) =>
		listDefined(content, kind).flatMap((entry, i, all) =>
			all.findIndex(({ id }) => id === entry.id) < i
				? [fail("uniqueIds", entry.path, entry.value, "an id is defined once in content.")]
				: [],
		),
	);
}

/**
 * R4, R5 and R6 for every unlock list of the Level table (MUST-05.5, 10.4): each id a Level lists
 * names content that exists (a tier: a content facility, from tier 2 to its highest); each is
 * listed at one Level only, since `progress/` unlocks at the first listing (#159); and everything
 * content defines is listed, so it is reachable. Storage capacity and trough upgrades are M6
 * (#72 D3): the Level table has no lists for them yet.
 */
export function checkUnlocks(content: Content): ContentFailure[] {
	return unlockKinds.flatMap((kind) => {
		const listings = mapListings(content, kind);
		const defined = listDefined(content, kind);
		const definedIds = new Set(defined.map(({ id }) => id));
		const all = [...listings.values()].flat();
		const missing = all.flatMap((listing) =>
			definedIds.has(listing.id)
				? []
				: [
						fail(
							"unlockExists",
							listing.path,
							listing.value,
							`a Level unlocks ${kind} that content defines (MUST-10.4).`,
						),
					],
		);
		const repeated = [...listings.values()].flatMap((list) =>
			list
				.slice(1)
				.map((listing) =>
					fail(
						"listedOnce",
						listing.path,
						listing.value,
						`it is already listed at Level ${String(list[0]?.level)}; an id is listed at one Level only.`,
					),
				),
		);
		const unlisted = defined.flatMap((entry) =>
			listings.has(entry.id)
				? []
				: [
						fail(
							"listedSomewhere",
							entry.path,
							entry.value,
							"no Level lists it, so it is never reachable (MUST-05.5).",
						),
					],
		);
		return [...missing, ...repeated, ...unlisted];
	});
}
