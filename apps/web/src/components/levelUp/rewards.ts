import { sliceContent, type AddOn, type LevelRow } from "@sunny-pastures/sim";

// What reaching a Level gives, as the level-up dialog says it (#607; MUST-05.4): its row of the
// Level table read into sentences. Content holds ids only, so the names are copy and live with the
// screen, as the HUD's and the order board's do (GLOSSARY.md, "Goods", "Facility").

/** One Level reached: its level-up coins and what it unlocks, one line each. */
export interface LevelReward {
	readonly level: number;
	readonly coins: number;
	readonly unlocks: readonly string[];
}

/** The rewards of Levels `from` through `to`, in order; empty when `to` is below `from`. */
export function listRewards(from: number, to: number): readonly LevelReward[] {
	return sliceContent.levels.flatMap((row, i) => {
		const level = i + 1;
		return level >= from && level <= to ? [describeLevel(level, row)] : [];
	});
}

const addOnNames = {
	loop: "Loop",
	collector: "Collector",
} as const satisfies Record<AddOn, string>;

/** The slice's facilities and pens (`sliceContent`), by id. */
const buildingNames: Readonly<Record<string, string>> = {
	feedMill: "Feed mill",
	bakery: "Bakery",
	chickenPen: "Chicken pen",
};

/** The slice's goods (`sliceContent`) as a list names them, in lower case. */
const goodNames: Readonly<Record<string, string>> = {
	wheat: "wheat",
	chickenFeed: "chicken feed",
	egg: "eggs",
	bread: "bread",
	cookies: "cookies",
};

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

function describeLevel(level: number, row: LevelRow): LevelReward {
	const unlocks = [
		...row.crops.map((crop) => `${capitalise(nameGood(crop))}, unlocked to plant`),
		...row.facilities.map((id) => `${nameBuilding(id)}, unlocked to buy`),
		...row.pens.map((id) => `${nameBuilding(id)}, unlocked to buy`),
		...row.tiers.map(
			({ facility, tier }) => `${nameBuilding(facility)} tier ${String(tier)}, unlocked to buy`,
		),
		...row.addOns.map((addOn) => `The ${addOnNames[addOn]} add-on, unlocked to buy`),
		...countMore(row.plots, "plot", "to buy"),
		...countMore(row.orderSlots, "order slot", "on the order board"),
	];
	if (row.orderGoods.length > 0) {
		const goods = listFormat.format(row.orderGoods.map((good) => nameGood(good)));
		unlocks.push(`Orders may now ask for ${goods}`);
	}

	return { level, coins: row.coins, unlocks };
}

/** A facility's or pen's name; an id with no name reads as itself, so new content still shows. */
function nameBuilding(id: string): string {
	return buildingNames[id] ?? id;
}

/** A good's name in a list; an id with no name reads as itself. */
function nameGood(id: string): string {
	return goodNames[id] ?? id;
}

/** "2 more plots to buy"; nothing for 0. */
function countMore(count: number, noun: string, rest: string): readonly string[] {
	if (count === 0) return [];

	return [`${String(count)} more ${noun}${count === 1 ? "" : "s"} ${rest}`];
}

function capitalise(words: string): string {
	return words.charAt(0).toUpperCase() + words.slice(1);
}
