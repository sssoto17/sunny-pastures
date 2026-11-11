// Content is data handed to createSim, never imported by the rules (ADR-0003, section 1, D5). The
// values are the admin's (spec, "How to read this spec"; CONSTRAINTS.md, "Content change" row):
// approved for the wheat slice on 11 Nov (#82), and the Level table and plot prices on 11 Nov (#83),
// to be tuned after playtest 1.

/** What the rules read: every number is a safe integer, and grow times are whole seconds (MUST-10.4). */
export interface Content {
	/** A new farm (spec decision 5). */
	readonly start: { readonly coins: number; readonly plots: number };
	/** The silo holds at most `capacity` crops in all (MUST-06.4). */
	readonly silo: { readonly capacity: number };
	/** The barn holds at most `capacity` goods in all: every good that isn't a crop (MUST-06.4). */
	readonly barn: { readonly capacity: number };
	/** Crops by good id. */
	readonly crops: Readonly<Record<string, Crop>>;
	/**
	 * The Level table, Level 1 first: row i is Level i + 1 (MUST-05.3). Each row lists what reaching
	 * it adds (MUST-05.4). Level 1's XP is 0, and the thresholds rise strictly (MUST-10.4).
	 */
	readonly levels: readonly LevelRow[];
	/**
	 * What the plots beyond the start cost (MUST-06.1): the first `first` coins, and each next one
	 * `growthPerMille` / 1000 times the one before, rounded down (D16: integers only, no Math.pow).
	 */
	readonly plotPrice: { readonly first: number; readonly growthPerMille: number };
}

/** One Level of the Level table: what reaching it takes, pays and unlocks. */
export interface LevelRow {
	/** The XP that reaches it. */
	readonly xp: number;
	/** The level-up coins it pays once, when reached (MUST-05.4); Level 1's are never paid. */
	readonly coins: number;
	/** Crop ids it unlocks for planting (MUST-01.1, 01.5). */
	readonly crops: readonly string[];
	/** How many more plots it allows the farm to buy (MUST-06.1). */
	readonly plots: number;
}

export interface Crop {
	/** Coins that planting costs (MUST-01.1). */
	readonly seedPrice: number;
	/** Whole seconds from planting to ready (MUST-01.2); createSim converts it to ms once (D7). */
	readonly growSeconds: number;
	readonly baseYield: number;
	/** The chance of the bonus, out of 1000, drawn from the yields stream (MUST-01.4, D16). */
	readonly bonusPerMille: number;
	readonly bonusYield: number;
	/** XP a harvest gives (MUST-01.3). */
	readonly xp: number;
}

/** An amount of one good. */
export interface GoodCount {
	readonly good: string;
	readonly amount: number;
}

/** The M4 slice's content, wheat only for now (#72, D1). */
export const sliceContent = {
	start: { coins: 50, plots: 6 },
	silo: { capacity: 50 },
	barn: { capacity: 50 },
	crops: {
		wheat: {
			seedPrice: 2,
			growSeconds: 120,
			baseYield: 2,
			bonusPerMille: 100,
			bonusYield: 1,
			xp: 1,
		},
	},
	levels: [
		{ xp: 0, coins: 0, crops: ["wheat"], plots: 0 },
		{ xp: 10, coins: 20, crops: [], plots: 2 },
		{ xp: 30, coins: 30, crops: [], plots: 2 },
		{ xp: 60, coins: 40, crops: [], plots: 2 },
		{ xp: 100, coins: 50, crops: [], plots: 2 },
	],
	plotPrice: { first: 20, growthPerMille: 1500 },
} as const satisfies Content;
