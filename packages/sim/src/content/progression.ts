// The content check's rules on Level thresholds, Level 1 and plot prices (MUST-01.5, 05.3, 06.1,
// 10.4; ADR-0003, sections 11 and 17).
import { fail } from "./failure.js";
import type { Content, ContentFailure } from "./index.js";

/**
 * R7 (MUST-05.3, 10.4): Level 1 is at 0 XP and the thresholds rise strictly. `levelOf` counts the
 * rows a farm's XP has reached, so it assumes both.
 */
export function checkThresholds(content: Content): ContentFailure[] {
	const [first] = content.levels;
	if (first === undefined) {
		return [fail("levelThresholds", "levels", [], "the Level table has a row for Level 1.")];
	}

	return content.levels.flatMap((row, i) => {
		const path = `levels[${String(i)}].xp`;
		if (i === 0) {
			return row.xp === 0 ? [] : [fail("levelThresholds", path, row.xp, "Level 1 is at 0 XP.")];
		}

		const before = content.levels[i - 1]?.xp ?? 0;
		return row.xp > before
			? []
			: [
					fail(
						"levelThresholds",
						path,
						row.xp,
						`it doesn't rise above Level ${String(i)}'s ${String(before)} XP.`,
					),
				];
	});
}

/** R8 (MUST-01.5): wheat is unlocked at Level 1. */
export function checkWheat(content: Content): ContentFailure[] {
	const crops = content.levels[0]?.crops ?? [];
	return crops.includes("wheat")
		? []
		: [
				fail(
					"wheatAtLevel1",
					"levels[0].crops",
					crops,
					"wheat is unlocked at Level 1 (MUST-01.5).",
				),
			];
}

/**
 * R12 (MUST-06.1; #159, #160): each extra plot costs more than the one before. With integer floor
 * steps that needs `first > 0` and `first × (growthPerMille − 1000) ≥ 1000`: `first: 1,
 * growthPerMille: 1500` floors every price to 1. Once it holds for the first price it holds for
 * every larger one. R13 (#160): every price step the Level table allows stays a safe integer,
 * computed with the rules' integer steps (D16; ADR-0003, section 11).
 */
export function checkPlotPrices(content: Content): ContentFailure[] {
	const { first, growthPerMille } = content.plotPrice;
	const rises = checkPlotPriceRises(first, growthPerMille);
	const plots = content.levels.reduce(
		(total, row) => total + (Number.isSafeInteger(row.plots) && row.plots > 0 ? row.plots : 0),
		0,
	);
	let price = first;
	for (let plot = 2; plot <= plots; plot++) {
		const step = price * growthPerMille;
		if (!Number.isSafeInteger(step)) {
			return [
				...rises,
				fail(
					"plotPriceSafe",
					"plotPrice",
					content.plotPrice,
					`extra plot ${String(plot)}'s price step is ${String(step)}, past Number.MAX_SAFE_INTEGER (D16).`,
				),
			];
		}

		price = Math.floor(step / 1000);
	}
	return rises;
}

function checkPlotPriceRises(first: number, growthPerMille: number): ContentFailure[] {
	if (first <= 0) {
		return [
			fail(
				"plotPriceRises",
				"plotPrice.first",
				first,
				"the first extra plot costs more than 0 (MUST-06.1).",
			),
		];
	}
	if (first * (growthPerMille - 1000) >= 1000) return [];

	return [
		fail(
			"plotPriceRises",
			"plotPrice.growthPerMille",
			growthPerMille,
			`from a first price of ${String(first)}, the next plot doesn't cost more when rounded down (MUST-06.1).`,
		),
	];
}
