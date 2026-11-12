// The content check's rules on the silo and the barn (MUST-06.4; ADR-0003, sections 12, 15 and 17).
import { fail } from "./failure.js";
import type { Content, ContentFailure } from "./index.js";

/** MUST-04.2: an order asks for 1–3 kinds of goods. */
const mostKinds = 3;

/**
 * R24 (#86's review, C3): a new farm's barn goods, once content gives them (`start.barn`, not in
 * the slice: new farms start with an empty barn), each count above 0, since a good has a key only
 * while its count is, and their sum within `barn.capacity`. Today's `Content` has no such field,
 * so the rule reads it as unknown data (the admin, 12 Nov).
 */
export function checkStartBarn(content: Content): ContentFailure[] {
	if (!("barn" in content.start)) return [];

	const { barn }: { barn: unknown } = content.start;
	if (typeof barn !== "object" || barn === null || Array.isArray(barn)) {
		return [fail("startBarn", "start.barn", barn, "a new farm's barn maps goods to counts.")];
	}

	const counts = Object.entries(barn).map(
		([good, count]: [string, unknown]) => [good, count] as const,
	);
	const failures = counts.flatMap(([good, count]) =>
		typeof count === "number" && count > 0
			? []
			: [
					fail(
						"startBarn",
						`start.barn.${good}`,
						count,
						"a good has a key only while its count is above 0.",
					),
				],
	);
	const total = counts.reduce((sum, [, count]) => sum + (typeof count === "number" ? count : 0), 0);
	return total > content.barn.capacity
		? [
				...failures,
				fail(
					"startBarn",
					"start.barn",
					barn,
					`its ${String(total)} goods don't fit the barn's ${String(content.barn.capacity)} (MUST-06.4).`,
				),
			]
		: failures;
}

/**
 * R30 (O8): the largest order fits each store: an order asks for up to 3 kinds, so the 3 largest
 * `max` amounts among the order goods a store holds sum to within its capacity (crops in the silo,
 * every other good in the barn, MUST-06.4). Otherwise that order could never be delivered.
 */
export function checkOrderFits(content: Content): ContentFailure[] {
	return (["silo", "barn"] as const).flatMap((store) => {
		const largest = content.orderGoods
			.filter(({ good }) => Object.hasOwn(content.crops, good) === (store === "silo"))
			.map(({ max }) => max)
			.sort((a, b) => b - a)
			.slice(0, mostKinds);
		const total = largest.reduce((sum, max) => sum + max, 0);
		const { capacity } = content[store];
		return total <= capacity
			? []
			: [
					fail(
						"orderFits",
						`${store}.capacity`,
						capacity,
						`the largest order of ${store} goods asks for ${String(total)} (${largest.join(" + ")}).`,
					),
				];
	});
}
