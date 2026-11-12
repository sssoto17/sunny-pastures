// The content check's rules on animal pens (MUST-02; ADR-0003, sections 13 and 17).
import { fail } from "./failure.js";
import type { Content, ContentFailure } from "./index.js";

/** MUST-02.1's chickens, as content names their pen; cows are M6's. */
const chickens = {
	pen: "chickenPen",
	feed: "chickenFeed",
	product: "egg",
} as const;

/**
 * R21 (MUST-02.5; #86): a pen holds at least one animal, and its trough holds one portion at the
 * start (larger troughs are MUST-06.3, M6). R22 (#86): its feed and product aren't crops, which
 * `storage/` would send to the silo. R23 (MUST-02.1): chickens eat chicken feed and lay eggs.
 */
export function checkPens(content: Content): ContentFailure[] {
	const isCrop = (good: string): boolean => Object.hasOwn(content.crops, good);
	const pens = content.pens.flatMap((pen, i) => {
		const at = `pens[${String(i)}]`;
		return [
			...(pen.animals >= 1
				? []
				: [fail("penSize", `${at}.animals`, pen.animals, "a pen holds at least 1 animal (#86).")]),
			...(pen.troughCapacity === 1
				? []
				: [
						fail(
							"penSize",
							`${at}.troughCapacity`,
							pen.troughCapacity,
							"a trough holds one portion at the start (MUST-02.5).",
						),
					]),
			...(["feed", "product"] as const).flatMap((field) =>
				isCrop(pen[field])
					? [
							fail(
								"penGoods",
								`${at}.${field}`,
								pen[field],
								"a pen's goods are barn goods, not crops (#86).",
							),
						]
					: [],
			),
		];
	});
	const i = content.pens.findIndex(({ id }) => id === chickens.pen);
	const chickenPen = content.pens[i];
	const animals =
		chickenPen === undefined
			? [
					fail(
						"animals",
						"pens",
						content.pens.map(({ id }) => id),
						"the slice has chickens (MUST-02.1; #72 D1).",
					),
				]
			: (["feed", "product"] as const).flatMap((field) =>
					chickenPen[field] === chickens[field]
						? []
						: [
								fail(
									"animals",
									`pens[${String(i)}].${field}`,
									chickenPen[field],
									`chickens' ${field} is ${chickens[field]} (MUST-02.1).`,
								),
							],
				);
	return [...pens, ...animals];
}
