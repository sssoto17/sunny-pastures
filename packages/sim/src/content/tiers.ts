// The content check's rules on facility tiers (MUST-03.5, 06.2, 10.4; ADR-0003, sections 14 and
// 17).
import { fail, isTimer } from "./failure.js";
import type { Content, ContentFailure } from "./index.js";

/** MUST-06.2: facilities go up to tier 3 here; tiers 4–5 are SHOULD-08. */
const highestTier = 3;

/**
 * R3 (#189; ADR-0003, section 14): every recipe's job time at every tier that can make it is a
 * MUST-10.4 timer. The rules work it out as `floor(seconds × timePerMille / 1000)` whole seconds
 * (D16), so the tier-1 `seconds` alone doesn't bound it: `seconds: 10, timePerMille: 800` gives
 * 8 s. Tier 1's time is the recipe's `seconds`, which R2 checks.
 */
export function checkTierTimes(content: Content): ContentFailure[] {
	return content.facilities.flatMap((facility, i) =>
		Object.entries(facility.recipes).flatMap(([id, recipe]) =>
			facility.tiers.flatMap(({ timePerMille }, j) => {
				const tier = j + 2;
				const seconds = Math.floor((recipe.seconds * timePerMille) / 1000);
				return tier < recipe.tier || isTimer(seconds)
					? []
					: [
							fail(
								"tierTime",
								`facilities[${String(i)}].recipes.${id}.seconds`,
								recipe.seconds,
								`at tier ${String(tier)} a job takes ${String(seconds)} s, outside 10 s to 24 h (MUST-10.4).`,
							),
						];
			}),
		),
	);
}

/**
 * R17 (MUST-06.2; #189): each tier shortens jobs: its `timePerMille` is above 0, below 1000, and
 * below the tier before's. R18 (MUST-03.5, 06.2): a facility has at least 1 slot at tier 1, and
 * "every 2nd tier adds a queue slot, up to a maximum" reads as: tier 2 adds exactly one slot, each
 * later even tier adds one until the slots stop rising, odd tiers add none, and once an even tier
 * adds none no later tier adds one (the admin's 2/3/3, 11 Nov, #85; confirmed 12 Nov).
 * R19 (MUST-06.2): at most two tier rows, so tier 3 is the highest. R20 (#189): every tier costs
 * more than 0.
 */
export function checkTiers(content: Content): ContentFailure[] {
	return content.facilities.flatMap((facility, i) => {
		const at = `facilities[${String(i)}]`;
		const failures: ContentFailure[] = [];
		if (facility.slots < 1) {
			failures.push(
				fail("tierSlots", `${at}.slots`, facility.slots, "tier 1 has at least 1 slot (MUST-03.5)."),
			);
		}
		if (facility.tiers.length > highestTier - 1) {
			failures.push(
				fail(
					"tierCount",
					`${at}.tiers.length`,
					facility.tiers.length,
					"a facility has at most two tier rows: it goes up to tier 3 (MUST-06.2).",
				),
			);
		}
		let hasReachedMax = false;
		facility.tiers.forEach((row, j) => {
			const tier = j + 2;
			const path = `${at}.tiers[${String(j)}]`;
			const below = facility.tiers[j - 1];
			const perMilleBelow = below?.timePerMille ?? 1000;
			if (row.timePerMille <= 0 || row.timePerMille >= perMilleBelow) {
				failures.push(
					fail(
						"tierSpeed",
						`${path}.timePerMille`,
						row.timePerMille,
						`each tier shortens jobs: above 0 and below ${String(perMilleBelow)} (MUST-06.2).`,
					),
				);
			}

			const slotsBelow = below?.slots ?? facility.slots;
			const added = row.slots - slotsBelow;
			if (!listSlotsAdded(tier, hasReachedMax).includes(added)) {
				failures.push(
					fail(
						"tierSlots",
						`${path}.slots`,
						row.slots,
						`tier ${String(tier)} adds ${String(added)} to ${String(slotsBelow)} slots: every 2nd tier adds one, up to a maximum (MUST-06.2).`,
					),
				);
			}
			if (tier % 2 === 0 && added !== 1) hasReachedMax = true;
			if (row.price <= 0) {
				failures.push(
					fail("tierPrice", `${path}.price`, row.price, "a tier costs more than 0 coins (#189)."),
				);
			}
		});
		Object.entries(facility.recipes).forEach(([id, recipe]) => {
			if (
				!Number.isInteger(recipe.tier) ||
				recipe.tier < 1 ||
				recipe.tier > facility.tiers.length + 1
			) {
				failures.push(
					fail(
						"tierCount",
						`${at}.recipes.${id}.tier`,
						recipe.tier,
						`a recipe's tier is from 1 to the ${facility.id}'s highest (MUST-06.2).`,
					),
				);
			}
		});
		return failures;
	});
}

/**
 * The slots tier `tier` may add (MUST-06.2): one at tier 2, none at an odd tier or once an even
 * tier has added none (the maximum is reached), and one or none at a later even tier.
 */
function listSlotsAdded(tier: number, hasReachedMax: boolean): readonly number[] {
	if (tier % 2 === 1 || hasReachedMax) return [0];

	return tier === 2 ? [1] : [0, 1];
}
