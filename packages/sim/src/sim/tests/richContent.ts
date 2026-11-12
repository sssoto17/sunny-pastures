import { sliceContent } from "../../index.js";
import type { Content } from "../../index.js";

/** The test content's job XP: enough that a collect crosses two Levels in one gain (MUST-05.4). */
export const richJobXp = 51;
/** The test content's chicken feed time: 61 s, so tiers 2 and 3 round down to 48 s and 36 s (D16). */
export const richFeedSeconds = 61;

/**
 * Test content with the slice's Level table and plot prices, but room and coins to reach every
 * Level and plot: wheat isn't sold yet (#87), so the slice's silo keeps a farm near Level 2.
 * 9 XP a harvest keeps a farm that has bought a facility below Level 5 for a while, so collects
 * reach Levels (#85: at 31 a harvest, one tending reached Level 5 before any collect), and 51 XP
 * a collect from 18 or 27 XP crosses Levels 3 and 4 in one gain. A small barn fills after a few
 * collects, so collects and the Collector reach its bound and its refusal. Chicken feed's 61 s doesn't divide by the
 * tiers' per mille, so a job time that isn't rounded down to whole seconds fails 14.5 (#85).
 */
export const richContent: Content = {
	...sliceContent,
	start: { ...sliceContent.start, coins: 2_000 },
	silo: { capacity: 100_000 },
	barn: { capacity: 4 },
	crops: { wheat: { ...sliceContent.crops.wheat, xp: 9 } },
	facilities: sliceContent.facilities.map((facility) => ({
		...facility,
		recipes: Object.fromEntries(
			Object.entries(facility.recipes).map(([id, recipe]) => [
				id,
				{ ...recipe, xp: richJobXp, ...(id === "chickenFeed" ? { seconds: richFeedSeconds } : {}) },
			]),
		),
	})),
};
