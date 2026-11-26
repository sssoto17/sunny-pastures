// The content check's rules on numbers and timers (ADR-0003, section 17). It changes no value.
import { fail, isTimer } from "./failure.js";
import type { Content, ContentFailure } from "./index.js";

/**
 * R1 (D16; ADR-0003, section 10): every number in content is a safe integer, not -0 and not
 * negative: prices, coins, XP, amounts, capacities, plots, slots and per-milles alike. The rules
 * add, multiply and store them, so a fraction or a -0 would reach the state.
 */
export function checkNumbers(content: Content): ContentFailure[] {
	return listNumbers(content, "").flatMap(([path, value]) =>
		Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
			? []
			: [fail("safeInteger", path, value, "content numbers are safe integers of 0 or more (D16).")],
	);
}

/**
 * R2 (MUST-10.4): every timer is a whole number of seconds from 10 s to 24 h: each crop's grow
 * time, each recipe's tier-1 time, each pen's laying time and both refill delays at every Level.
 * A 0 s recipe or pen time repeats a step key, which `advance` throws on (#86, #88).
 */
export function checkTimers(content: Content): ContentFailure[] {
	const timers: [string, number][] = [
		...Object.entries(content.crops).map(([id, crop]): [string, number] => [
			`crops.${id}.growSeconds`,
			crop.growSeconds,
		]),
		...content.facilities.flatMap((facility, i) =>
			Object.entries(facility.recipes).map(([id, recipe]): [string, number] => [
				`facilities[${String(i)}].recipes.${id}.seconds`,
				recipe.seconds,
			]),
		),
		...content.pens.map((pen, i): [string, number] => [`pens[${String(i)}].seconds`, pen.seconds]),
		...content.levels.flatMap((row, i): [string, number][] => [
			[`levels[${String(i)}].refillSeconds.delivered`, row.refillSeconds.delivered],
			[`levels[${String(i)}].refillSeconds.discarded`, row.refillSeconds.discarded],
		]),
	];
	return timers.flatMap(([path, seconds]) =>
		isTimer(seconds)
			? []
			: [
					fail(
						"timer",
						path,
						seconds,
						"a timer is a whole number of seconds from 10 to 86400 (MUST-10.4).",
					),
				],
	);
}

/** Every number in `value`, with its path (`levels[1].xp`). */
function listNumbers(value: unknown, path: string): [string, number][] {
	if (typeof value === "number") return [[path, value]];

	if (Array.isArray(value)) {
		return value.flatMap((item, i) => listNumbers(item, `${path}[${String(i)}]`));
	}

	if (typeof value === "object" && value !== null) {
		return Object.entries(value).flatMap(([key, item]) =>
			listNumbers(item, path === "" ? key : `${path}.${key}`),
		);
	}

	return [];
}
