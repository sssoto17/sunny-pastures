// The content check's rules on the order things unlock in (MUST-05.5, 06.2; ADR-0003, sections 14,
// 16 and 17).
import { fail } from "./failure.js";
import type { Content, ContentFailure } from "./index.js";
import { findUnlockLevel, formatTierId, mapListings } from "./unlocks.js";

/**
 * R9 (#189; MUST-05.5, 06.2): a tier is never unlocked before its facility, and tier n + 1 never
 * at a lower Level than tier n. R10 (#88): an add-on, which every facility can have, is unlocked
 * no earlier than the first facility. Ids no Level lists are R6's.
 */
export function checkUnlockOrder(content: Content): ContentFailure[] {
	const facilities = mapListings(content, "facilities");
	const tiers = mapListings(content, "tiers");
	const tierFailures = content.facilities.flatMap((facility) => {
		const facilityLevel = findUnlockLevel(facilities, facility.id);
		return facility.tiers.flatMap((_row, j) => {
			const tier = j + 2;
			const listing = tiers.get(formatTierId(facility.id, tier))?.[0];
			if (listing === undefined) return [];

			const below = tier === 2 ? null : findUnlockLevel(tiers, formatTierId(facility.id, tier - 1));
			return [
				...(facilityLevel !== null && listing.level < facilityLevel
					? [
							fail(
								"tierOrder",
								listing.path,
								listing.value,
								`the ${facility.id} unlocks at Level ${String(facilityLevel)}, after its tier.`,
							),
						]
					: []),
				...(below !== null && listing.level < below
					? [
							fail(
								"tierOrder",
								listing.path,
								listing.value,
								`tier ${String(tier - 1)} unlocks at Level ${String(below)}, after tier ${String(tier)}.`,
							),
						]
					: []),
			];
		});
	});
	const facilityLevels = [...facilities.values()].map((list) => list[0]?.level ?? Infinity);
	const firstFacility = Math.min(...facilityLevels);
	const addOnFailures = [...mapListings(content, "addOns").values()].flatMap((list) => {
		const listing = list[0];
		return listing !== undefined && listing.level < firstFacility
			? [
					fail(
						"addOnOrder",
						listing.path,
						listing.value,
						`the first facility unlocks at Level ${String(firstFacility)}, after the add-on.`,
					),
				]
			: [];
	});
	return [...tierFailures, ...addOnFailures];
}
