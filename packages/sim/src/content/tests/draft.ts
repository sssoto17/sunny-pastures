import { checkContent, sliceContent } from "../index.js";
import type { Content, ContentRule } from "../index.js";

/** Content with every field writable, so a test changes the fewest values that break one rule. */
export type Draft<T> = T extends readonly (infer U)[]
	? Draft<U>[]
	: T extends object
		? { -readonly [K in keyof T]: Draft<T[K]> }
		: T;

/** A fresh, writable copy of the slice content: a JSON copy, since content is plain data. */
export function draftSlice(): Draft<Content> {
	return JSON.parse(JSON.stringify(sliceContent)) as Draft<Content>;
}

/** Level `level` of the draft's Level table, counted from 1. */
export function findLevel(
	content: Draft<Content>,
	level: number,
): Draft<Content>["levels"][number] {
	return requireFound(content.levels[level - 1], `Level ${String(level)}`);
}

export function findCrop(content: Draft<Content>, id: string): Draft<Content>["crops"][string] {
	return requireFound(content.crops[id], `crop ${id}`);
}

export function findFacility(
	content: Draft<Content>,
	id: string,
): Draft<Content>["facilities"][number] {
	return requireFound(
		content.facilities.find((entry) => entry.id === id),
		`facility ${id}`,
	);
}

export function findRecipe(
	content: Draft<Content>,
	facilityId: string,
	id: string,
): Draft<Content>["facilities"][number]["recipes"][string] {
	return requireFound(findFacility(content, facilityId).recipes[id], `recipe ${id}`);
}

export function findPen(content: Draft<Content>, id: string): Draft<Content>["pens"][number] {
	return requireFound(
		content.pens.find((entry) => entry.id === id),
		`pen ${id}`,
	);
}

export function findOrderGood(
	content: Draft<Content>,
	good: string,
): Draft<Content>["orderGoods"][number] {
	return requireFound(
		content.orderGoods.find((entry) => entry.good === good),
		`order good ${good}`,
	);
}

/**
 * What the check reports, as [rule, path] in its order: a test asserts the whole list, so it
 * proves the rule it breaks fails and no other does.
 */
export function listFailures(content: Content): readonly (readonly [ContentRule, string])[] {
	return checkContent(content).map(({ rule, path }) => [rule, path] as const);
}

function requireFound<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`The slice content has no ${what}.`);

	return value;
}
