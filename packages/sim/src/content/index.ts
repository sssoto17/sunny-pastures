// Content is data handed to createSim, never imported by the rules (ADR-0003, section 1, D5). The
// values are the admin's (spec, "How to read this spec"; CONSTRAINTS.md, "Content change" row):
// approved for the wheat slice on 11 Nov (#82), and the Level table and plot prices on 11 Nov (#83);
// the barn, the facilities and their recipes chosen by #84's lane (11 Nov, its PRs' "Decided by the
// lane"); the chicken pen chosen by #86's lane (11 Nov, its PRs' "Decided by the lane"). All to be tuned after playtest 1.

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
	/** The facilities, in content order: a facility's index here is its index in the state (D12). */
	readonly facilities: readonly Facility[];
	/** The animal pens, in content order: a pen's index here is its index in the state (D12). */
	readonly pens: readonly Pen[];
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
	/** Facility ids it unlocks for buying (MUST-05.6). */
	readonly facilities: readonly string[];
	/** Pen ids it unlocks for buying (spec decision 1, MUST-05.6). */
	readonly pens: readonly string[];
}

/** A facility the farm can buy once a Level unlocks it (MUST-03, MUST-05.6). */
export interface Facility {
	readonly id: string;
	/** Coins that buying it costs. */
	readonly price: number;
	/** Queue slots at tier 1 (MUST-03.5); #85 adds the slots of higher tiers (MUST-06.2). */
	readonly slots: number;
	/** What it can make, by recipe id (MUST-03.1). */
	readonly recipes: Readonly<Record<string, Recipe>>;
}

/** One run of a recipe is a job (`GLOSSARY.md`). */
export interface Recipe {
	/** The lowest facility tier that can make it (MUST-03.1). */
	readonly tier: number;
	/** Taken from storage when a job starts (MUST-03.2), in this order. */
	readonly inputs: readonly GoodCount[];
	/** Waits in the facility once the job finishes, until collected (MUST-03.4). */
	readonly output: GoodCount;
	/** Whole seconds a job takes (MUST-03.3, MUST-10.4); createSim converts it to ms once (D7). */
	readonly seconds: number;
	/** XP that collecting a job gives (MUST-05.2). */
	readonly xp: number;
}

/** An amount of one good. */
export interface GoodCount {
	readonly good: string;
	readonly amount: number;
}

/** An animal pen the farm can buy once a Level unlocks it (MUST-02). */
export interface Pen {
	readonly id: string;
	/** Coins that buying it costs. */
	readonly price: number;
	/** The animals it holds, each producing on its own (MUST-02.3); #72 D3 puts more in M6. */
	readonly animals: number;
	/** The good the animals eat, one portion per product (MUST-02.1). */
	readonly feed: string;
	/** Portions the trough holds: 1 at the start (MUST-02.5); larger troughs are M6 (MUST-06.3). */
	readonly troughCapacity: number;
	/** The good each portion becomes (MUST-02.1). */
	readonly product: string;
	/** Whole seconds from eating a portion to producing (MUST-02.3, MUST-10.4); in ms once (D7). */
	readonly seconds: number;
	/** XP each product collected gives (MUST-02.4, 05.2). */
	readonly xp: number;
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
		{ xp: 0, coins: 0, crops: ["wheat"], plots: 0, facilities: [], pens: [] },
		{ xp: 10, coins: 20, crops: [], plots: 2, facilities: ["feedMill"], pens: ["chickenPen"] },
		{ xp: 30, coins: 30, crops: [], plots: 2, facilities: ["bakery"], pens: [] },
		{ xp: 60, coins: 40, crops: [], plots: 2, facilities: [], pens: [] },
		{ xp: 100, coins: 50, crops: [], plots: 2, facilities: [], pens: [] },
	],
	plotPrice: { first: 20, growthPerMille: 1500 },
	facilities: [
		{
			id: "feedMill",
			price: 30,
			slots: 2,
			recipes: {
				chickenFeed: {
					tier: 1,
					inputs: [{ good: "wheat", amount: 2 }],
					output: { good: "chickenFeed", amount: 2 },
					seconds: 60,
					xp: 1,
				},
			},
		},
		{
			id: "bakery",
			price: 50,
			slots: 2,
			recipes: {
				bread: {
					tier: 1,
					inputs: [{ good: "wheat", amount: 3 }],
					output: { good: "bread", amount: 1 },
					seconds: 300,
					xp: 2,
				},
			},
		},
	],
	pens: [
		{
			id: "chickenPen",
			price: 30,
			animals: 3,
			feed: "chickenFeed",
			troughCapacity: 1,
			product: "egg",
			seconds: 180,
			xp: 1,
		},
	],
} as const satisfies Content;
