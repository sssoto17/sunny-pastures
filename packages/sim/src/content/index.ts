// Content is data handed to createSim, never imported by the rules (ADR-0003, section 1, D5). The
// values are the admin's (spec, "How to read this spec"; CONSTRAINTS.md, "Content change" row):
// approved for the wheat slice on 11 Nov (#82), and the Level table and plot prices on 11 Nov (#83);
// the barn, the facilities and their recipes chosen by #84's lane (11 Nov, its PRs' "Decided by the
// lane"); the chicken pen chosen by #86's lane, the tiers and cookies by #85's, the order board by
// #87's, and the add-ons' prices and Levels by #88's (11 Nov, their PRs' "Decided by the lane").
// All to be tuned after playtest 1. `checkContent` holds any content to the rules it must keep
// (#89); its rule groups are private siblings.
import { checkUniqueIds, checkUnlocks } from "./levelTable.js";
import { checkNumbers, checkTimers } from "./numbers.js";
import { checkTiers, checkTierTimes } from "./tiers.js";
import { checkUnlockOrder } from "./unlockOrder.js";

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
	readonly plotPrice: {
		readonly first: number;
		readonly growthPerMille: number;
	};
	/** The facilities, in content order: a facility's index here is its index in the state (D12). */
	readonly facilities: readonly Facility[];
	/** The animal pens, in content order: a pen's index here is its index in the state (D12). */
	readonly pens: readonly Pen[];
	/** Each add-on's price in coins, the same for every facility (MUST-06.5, 06.6; #88). */
	readonly addOns: Readonly<Record<AddOn, { readonly price: number }>>;
	/**
	 * What orders may ask for and pay (MUST-04.2), in content order: draws pick from this order,
	 * never from object keys (MUST-10.6).
	 */
	readonly orderGoods: readonly OrderGood[];
}

/**
 * The add-ons a facility can have (`GLOSSARY.md`, "Add-on"): the Loop starts its last recipe again
 * (MUST-06.5), and the Collector moves its finished goods into storage (MUST-06.6).
 */
export type AddOn = "loop" | "collector";

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
	/** Add-ons it unlocks for buying, for every facility (MUST-05.5, 05.6; #88). */
	readonly addOns: readonly AddOn[];
	/** Facility tiers it unlocks for buying (MUST-05.5, 06.2; #85). */
	readonly tiers: readonly FacilityTier[];
	/** How many more order slots it gives the board (MUST-04.1): Level 1's are the board's first. */
	readonly orderSlots: number;
	/** Goods it unlocks for orders, by the ids in `orderGoods` (MUST-04.2; `GLOSSARY.md`, "Unlocked"). */
	readonly orderGoods: readonly string[];
	/**
	 * Whole seconds an order slot waits at this Level before it refills, after a delivery and after a
	 * discard (MUST-04.5, MUST-10.4); createSim converts them to ms once (D7).
	 */
	readonly refillSeconds: {
		readonly delivered: number;
		readonly discarded: number;
	};
}

/** One tier of one facility, as the Level table names it. */
export interface FacilityTier {
	/** A facility's id. */
	readonly facility: string;
	/** From 2: tier 1 comes with the facility. */
	readonly tier: number;
}

/** A facility the farm can buy once a Level unlocks it (MUST-03, MUST-05.6). */
export interface Facility {
	readonly id: string;
	/** Coins that buying it costs. */
	readonly price: number;
	/** Queue slots at tier 1 (MUST-03.5). */
	readonly slots: number;
	/** The tiers it can be upgraded to, tier 2 first, each the next (MUST-06.2; #85). */
	readonly tiers: readonly TierRow[];
	/** What it can make, by recipe id (MUST-03.1). */
	readonly recipes: Readonly<Record<string, Recipe>>;
}

/** A tier a facility can be upgraded to: bought once a Level unlocks it (MUST-06.2). */
export interface TierRow {
	/** Coins that buying it costs. */
	readonly price: number;
	/** Queue slots at this tier, never fewer than the tier below's (MUST-03.5). */
	readonly slots: number;
	/**
	 * A job's time at this tier, per mille of the recipe's `seconds`: whole seconds, rounded down
	 * (D16: integers only). Below 1000, so each tier shortens jobs.
	 */
	readonly timePerMille: number;
}

/** One run of a recipe is a job (`GLOSSARY.md`). */
export interface Recipe {
	/** The lowest facility tier that can make it (MUST-03.1). */
	readonly tier: number;
	/** Taken from storage when a job starts (MUST-03.2), in this order. */
	readonly inputs: readonly GoodCount[];
	/** Waits in the facility once the job finishes, until collected (MUST-03.4). */
	readonly output: GoodCount;
	/** Whole seconds a job takes at tier 1 (MUST-03.3, MUST-10.4); in ms once, per tier (D7). */
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

/** A good orders may ask for, once a Level unlocks it for orders (MUST-04.2). */
export interface OrderGood {
	readonly good: string;
	/** The fewest and most an order asks for (MUST-04.2's "set quantities"). */
	readonly min: number;
	readonly max: number;
	/** Coins and XP an order pays for each one asked for (MUST-04.2, 05.2). */
	readonly coins: number;
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

/**
 * A rule of the content check (MUST-10.4; ADR-0003, section 17). #89's PR body maps each to its
 * source and to the test that breaks it alone.
 */
export type ContentRule =
	| "safeInteger"
	| "timer"
	| "uniqueIds"
	| "unlockExists"
	| "listedOnce"
	| "listedSomewhere"
	| "tierOrder"
	| "addOnOrder"
	| "tierTime"
	| "tierSpeed"
	| "tierSlots"
	| "tierCount"
	| "tierPrice";

/** One broken rule: `path` names the value (`crops.wheat.growSeconds`), `message` says why. */
export interface ContentFailure {
	readonly rule: ContentRule;
	readonly path: string;
	/** A full sentence naming the path and its value. */
	readonly message: string;
}

/**
 * The content check (MUST-10.4; #89): every rule `content` breaks, in a fixed order, or none.
 * Pure and total over any `Content` value, so it runs on every rules version's content
 * (ADR-0006, "Consequences"); `createSim` doesn't call it (ADR-0003, section 17).
 */
export function checkContent(content: Content): readonly ContentFailure[] {
	return contentChecks.flatMap((check) => check(content));
}

/** Each rule group in turn: the order only sets the order of the failures (ADR-0003, section 17). */
const contentChecks: readonly ((content: Content) => readonly ContentFailure[])[] = [
	checkNumbers,
	checkTimers,
	checkUniqueIds,
	checkUnlocks,
	checkUnlockOrder,
	checkTierTimes,
	checkTiers,
];

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
		{
			xp: 0,
			coins: 0,
			crops: ["wheat"],
			plots: 0,
			facilities: [],
			pens: [],
			tiers: [],
			addOns: [],
			orderSlots: 3,
			orderGoods: ["wheat"],
			refillSeconds: { delivered: 120, discarded: 300 },
		},
		{
			xp: 10,
			coins: 20,
			crops: [],
			plots: 2,
			facilities: ["feedMill"],
			pens: ["chickenPen"],
			tiers: [],
			addOns: [],
			orderSlots: 1,
			orderGoods: ["chickenFeed", "egg"],
			refillSeconds: { delivered: 120, discarded: 300 },
		},
		{
			xp: 30,
			coins: 30,
			crops: [],
			plots: 2,
			facilities: ["bakery"],
			pens: [],
			tiers: [{ facility: "feedMill", tier: 2 }],
			addOns: [],
			orderSlots: 1,
			orderGoods: ["bread"],
			refillSeconds: { delivered: 90, discarded: 240 },
		},
		{
			xp: 60,
			coins: 40,
			crops: [],
			plots: 2,
			facilities: [],
			pens: [],
			tiers: [{ facility: "bakery", tier: 2 }],
			addOns: ["collector"],
			orderSlots: 1,
			orderGoods: [],
			refillSeconds: { delivered: 90, discarded: 240 },
		},
		{
			xp: 100,
			coins: 50,
			crops: [],
			plots: 2,
			facilities: [],
			pens: [],
			tiers: [
				{ facility: "feedMill", tier: 3 },
				{ facility: "bakery", tier: 3 },
			],
			addOns: ["loop"],
			orderSlots: 1,
			orderGoods: [],
			refillSeconds: { delivered: 60, discarded: 180 },
		},
	],
	plotPrice: { first: 20, growthPerMille: 1500 },
	facilities: [
		{
			id: "feedMill",
			price: 30,
			slots: 2,
			tiers: [
				{ price: 60, slots: 3, timePerMille: 800 },
				{ price: 120, slots: 3, timePerMille: 600 },
			],
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
			tiers: [
				{ price: 100, slots: 3, timePerMille: 800 },
				{ price: 200, slots: 3, timePerMille: 600 },
			],
			recipes: {
				bread: {
					tier: 1,
					inputs: [{ good: "wheat", amount: 3 }],
					output: { good: "bread", amount: 1 },
					seconds: 300,
					xp: 2,
				},
				cookies: {
					tier: 2,
					inputs: [
						{ good: "wheat", amount: 2 },
						{ good: "egg", amount: 2 },
					],
					output: { good: "cookies", amount: 1 },
					seconds: 500,
					xp: 5,
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
	addOns: { loop: { price: 80 }, collector: { price: 60 } },
	orderGoods: [
		{ good: "wheat", min: 2, max: 6, coins: 3, xp: 1 },
		{ good: "chickenFeed", min: 2, max: 4, coins: 4, xp: 1 },
		{ good: "egg", min: 1, max: 3, coins: 8, xp: 2 },
		{ good: "bread", min: 1, max: 2, coins: 15, xp: 4 },
	],
} as const satisfies Content;
