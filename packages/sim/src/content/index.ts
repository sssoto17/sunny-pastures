// Content is data handed to createSim, never imported by the rules (ADR-0003, section 1, D5). The
// values are the admin's (spec, "How to read this spec"; CONSTRAINTS.md, "Content change" row):
// approved for the wheat slice on 11 Nov (#82), to be tuned after playtest 1.

/** What the rules read: every number is a safe integer, and grow times are whole seconds (MUST-10.4). */
export interface Content {
	/** A new farm (spec decision 5). */
	readonly start: { readonly coins: number; readonly plots: number };
	/** The silo holds at most `capacity` crops in all. */
	readonly silo: { readonly capacity: number };
	/** Crops by good id. */
	readonly crops: Readonly<Record<string, Crop>>;
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
} as const satisfies Content;
