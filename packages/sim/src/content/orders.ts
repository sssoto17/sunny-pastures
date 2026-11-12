// The content check's rules on the order board (MUST-04, 05.2; #87's O1–O8; ADR-0003, sections
// 15 and 17).
import { fail } from "./failure.js";
import type { Content, ContentFailure } from "./index.js";
import { mapEarliestLevels, readUnlockLevels } from "./routes.js";
import { findUnlockLevel, mapListings } from "./unlocks.js";

/** MUST-04.1: the board has 3 slots at Level 1 and at most 9. */
const firstSlots = 3;
const mostSlots = 9;

/**
 * R25 (MUST-04.1; O1): Level 1 gives the board 3 slots, and the slots over all Levels sum to at
 * most 9. Each Level's are at least 0, which R1 checks, so the board never shrinks.
 */
export function checkOrderSlots(content: Content): ContentFailure[] {
	const first = content.levels[0]?.orderSlots;
	let total = 0;
	return [
		...(first === undefined || first === firstSlots
			? []
			: [
					fail(
						"orderSlots",
						"levels[0].orderSlots",
						first,
						"the board has 3 slots at Level 1 (MUST-04.1).",
					),
				]),
		...content.levels.flatMap((row, i) => {
			const before = total;
			total += row.orderSlots;
			return before <= mostSlots && total > mostSlots
				? [
						fail(
							"orderSlots",
							`levels[${String(i)}].orderSlots`,
							row.orderSlots,
							`it takes the board to ${String(total)} slots, above 9 (MUST-04.1).`,
						),
					]
				: [];
		}),
	];
}

/**
 * R26 (MUST-04.5; O2): at every Level a discarded order's slot waits longer than a delivered
 * one's, and neither delay gets longer as the Level rises. Both are timers (R2).
 */
export function checkRefillDelays(content: Content): ContentFailure[] {
	return content.levels.flatMap(({ refillSeconds }, i) => {
		const at = `levels[${String(i)}].refillSeconds`;
		const below = content.levels[i - 1]?.refillSeconds;
		return [
			...(refillSeconds.discarded > refillSeconds.delivered
				? []
				: [
						fail(
							"refillDelays",
							`${at}.discarded`,
							refillSeconds.discarded,
							`a discard waits longer than a delivery's ${String(refillSeconds.delivered)} s (MUST-04.5).`,
						),
					]),
			...(["delivered", "discarded"] as const).flatMap((kind) =>
				below === undefined || refillSeconds[kind] <= below[kind]
					? []
					: [
							fail(
								"refillDelays",
								`${at}.${kind}`,
								refillSeconds[kind],
								`it is longer than Level ${String(i)}'s ${String(below[kind])} s (MUST-04.5).`,
							),
						],
			),
		];
	});
}

/**
 * R27 (O4): every order good is produced by some route: a crop, a recipe's output or a pen's
 * product. R28 (O5; ADR-0003, section 15): Level 1 unlocks, for orders, a crop planted at Level 1,
 * so every draw has a good to ask for; `createSim` throws otherwise. R29 (MUST-04.2; O6): each
 * order good's `min` is at least 1 and its `max` at least its `min`.
 */
export function checkOrderGoods(content: Content): ContentFailure[] {
	const unlocks = readUnlockLevels(content);
	const earliest = mapEarliestLevels(content, unlocks);
	const forOrders = mapListings(content, "orderGoods");
	const goods = content.orderGoods.flatMap((entry, i) => {
		const at = `orderGoods[${String(i)}]`;
		return [
			...(earliest.has(entry.good)
				? []
				: [
						fail(
							"orderGoodProduced",
							`${at}.good`,
							entry.good,
							"no route produces it, so no order for it is ever delivered.",
						),
					]),
			...(entry.min >= 1
				? []
				: [
						fail(
							"orderAmounts",
							`${at}.min`,
							entry.min,
							"an order asks for at least 1 (MUST-04.2).",
						),
					]),
			...(entry.max >= entry.min
				? []
				: [
						fail(
							"orderAmounts",
							`${at}.max`,
							entry.max,
							`it is below the min of ${String(entry.min)}.`,
						),
					]),
		];
	});
	const hasFirstCrop = content.orderGoods.some(
		({ good }) =>
			findUnlockLevel(forOrders, good) === 1 &&
			Object.hasOwn(content.crops, good) &&
			unlocks.crop(good) === 1,
	);
	return hasFirstCrop
		? goods
		: [
				...goods,
				fail(
					"firstOrderCrop",
					"levels[0].orderGoods",
					content.levels[0]?.orderGoods ?? [],
					"Level 1 unlocks a crop planted at Level 1 for orders (ADR-0003, section 15).",
				),
			];
}

/**
 * R31 (MUST-05.2; O7): delivering earns most XP, so an order pays at least as much XP per good as
 * making that good does by any route: a harvest's XP per `baseYield`, a job's per output, a pen's
 * per product. Compared by cross-multiplying, in integers (D16).
 */
export function checkOrderXp(content: Content): ContentFailure[] {
	const made = [
		...Object.entries(content.crops).map(([good, crop]) => ({
			good,
			xp: crop.xp,
			per: crop.baseYield,
			by: "a harvest",
		})),
		...content.facilities.flatMap((facility) =>
			Object.entries(facility.recipes).map(([id, recipe]) => ({
				good: recipe.output.good,
				xp: recipe.xp,
				per: recipe.output.amount,
				by: `a ${id} job`,
			})),
		),
		...content.pens.map((pen) => ({
			good: pen.product,
			xp: pen.xp,
			per: 1,
			by: `the ${pen.id}`,
		})),
	];
	return content.orderGoods.flatMap((entry, i) =>
		made
			.filter(({ good, per }) => good === entry.good && per >= 1)
			.flatMap(({ xp, per, by }) =>
				entry.xp * per >= xp
					? []
					: [
							fail(
								"orderXp",
								`orderGoods[${String(i)}].xp`,
								entry.xp,
								`${by} gives ${String(xp)} XP for ${String(per)} ${entry.good}, more per good (MUST-05.2).`,
							),
						],
			),
	);
}
