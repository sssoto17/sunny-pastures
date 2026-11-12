// The content check's rules on crops and recipes (MUST-01, 03, 10.4; ADR-0003, sections 12 and
// 17).
import { fail } from "./failure.js";
import type { Content, ContentFailure } from "./index.js";
import { mapEarliestLevels, readUnlockLevels } from "./routes.js";

/**
 * MUST-03.1's recipes as far as the slice goes, as content names them (#72 D4: the slice ends in
 * cookies). The dairy, cow feed and strawberry cake are M6's.
 */
const specRecipes = [
	{ facility: "feedMill", recipe: "chickenFeed", tier: 1 },
	{ facility: "bakery", recipe: "bread", tier: 1 },
	{ facility: "bakery", recipe: "cookies", tier: 2 },
] as const;

/** The slice's facilities (#72 D1). */
const sliceFacilities = ["feedMill", "bakery"] as const;

/** R11 (#152): a harvest yields at least 1, or it would store a silo key with count 0. */
export function checkCrops(content: Content): ContentFailure[] {
	return Object.entries(content.crops).flatMap(([id, crop]) =>
		crop.baseYield >= 1
			? []
			: [
					fail(
						"cropYield",
						`crops.${id}.baseYield`,
						crop.baseYield,
						"a harvest yields at least 1 (#152).",
					),
				],
	);
}

/**
 * R14 (MUST-03.6, 10.4; #164, #189): every recipe input and every pen's feed is producible by some
 * route unlocked no later than the recipe (its facility's and tier's Level) or the pen.
 */
export function checkRoutes(content: Content): ContentFailure[] {
	const unlocks = readUnlockLevels(content);
	const earliest = mapEarliestLevels(content, unlocks);
	const isLate = (good: string, level: number): boolean => (earliest.get(good) ?? Infinity) > level;
	const why = (level: number): string =>
		`no route makes it by Level ${String(level)}, when it is needed (MUST-10.4).`;
	const recipes = content.facilities.flatMap((facility, i) =>
		Object.entries(facility.recipes).flatMap(([id, recipe]) => {
			const level = unlocks.recipe(facility, recipe);
			return level === null
				? []
				: recipe.inputs.flatMap(({ good }, k) =>
						isLate(good, level)
							? [
									fail(
										"inputProduced",
										`facilities[${String(i)}].recipes.${id}.inputs[${String(k)}].good`,
										good,
										why(level),
									),
								]
							: [],
					);
		}),
	);
	const pens = content.pens.flatMap((pen, i) => {
		const level = unlocks.pen(pen.id);
		return level !== null && isLate(pen.feed, level)
			? [fail("inputProduced", `pens[${String(i)}].feed`, pen.feed, why(level))]
			: [];
	});
	return [...recipes, ...pens];
}

/**
 * R15 (MUST-03.6): every crop and every animal product is an input to some recipe, and cookies
 * need goods from crops and animals: in the slice they stand in for strawberry cake, which also
 * needs the dairy in M6 (#72 D4).
 */
export function checkGoodsUsed(content: Content): ContentFailure[] {
	const recipes = content.facilities.flatMap((facility) => Object.values(facility.recipes));
	const inputs = new Set(recipes.flatMap(({ inputs }) => inputs.map(({ good }) => good)));
	const crops = Object.keys(content.crops);
	const products = content.pens.map(({ product }) => product);
	const unused = [
		...crops.map((id) => [`crops.${id}`, id] as const),
		...products.map((good, i) => [`pens[${String(i)}].product`, good] as const),
	].flatMap(([path, good]) =>
		inputs.has(good)
			? []
			: [
					fail(
						"goodUsed",
						path,
						good,
						"every crop and animal product is an input to a recipe (MUST-03.6).",
					),
				],
	);
	const mixed = content.facilities.flatMap((facility, i) => {
		const goods = facility.recipes["cookies"]?.inputs.map(({ good }) => good) ?? [];
		return goods.length === 0 ||
			(crops.some((good) => goods.includes(good)) && products.some((good) => goods.includes(good)))
			? []
			: [
					fail(
						"goodUsed",
						`facilities[${String(i)}].recipes.cookies.inputs`,
						goods,
						"cookies need goods from crops and from animals (MUST-03.6).",
					),
				];
	});
	return [...unused, ...mixed];
}

/**
 * R16 (MUST-03.1; #72 D4): each facility makes the spec's recipes at the spec's tiers, as far as
 * the slice goes: the feed mill chicken feed at tier 1, the bakery bread at tier 1 and cookies at
 * tier 2. A recipe makes the good it is named for.
 */
export function checkSliceRecipes(content: Content): ContentFailure[] {
	const ids = content.facilities.map(({ id }) => id);
	const missing = sliceFacilities.flatMap((id) =>
		ids.includes(id)
			? []
			: [fail("sliceRecipes", "facilities", ids, `the slice has a ${id} (#72 D1).`)],
	);
	const recipes = specRecipes.flatMap((spec) => {
		const i = ids.indexOf(spec.facility);
		const facility = content.facilities[i];
		if (facility === undefined) return [];

		const at = `facilities[${String(i)}].recipes`;
		const recipe = facility.recipes[spec.recipe];
		if (recipe === undefined) {
			return [
				fail(
					"sliceRecipes",
					at,
					Object.keys(facility.recipes),
					`the ${spec.facility} makes ${spec.recipe} (MUST-03.1).`,
				),
			];
		}

		return [
			...(recipe.tier === spec.tier
				? []
				: [
						fail(
							"sliceRecipes",
							`${at}.${spec.recipe}.tier`,
							recipe.tier,
							`${spec.recipe} is a tier-${String(spec.tier)} recipe (MUST-03.1).`,
						),
					]),
			...(recipe.output.good === spec.recipe
				? []
				: [
						fail(
							"sliceRecipes",
							`${at}.${spec.recipe}.output.good`,
							recipe.output.good,
							`the ${spec.recipe} recipe makes ${spec.recipe}.`,
						),
					]),
		];
	});
	return [...missing, ...recipes];
}
