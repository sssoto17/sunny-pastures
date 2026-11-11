import { sliceContent } from "../../index.js";
import type { Content } from "../../index.js";

/** The test content's job XP: enough that a collect crosses a Level (MUST-05.4). */
export const richJobXp = 31;

/**
 * Test content with the slice's Level table and plot prices, but room and coins to reach every
 * Level and plot: wheat isn't sold yet (#87), so the slice's silo keeps a farm near Level 2.
 * 31 XP a harvest crosses Levels 2 and 3 in one gain. A small barn fills after a few collects, so
 * collects and the Collector reach its bound and its refusal, and 31 XP a collect lets a collect
 * cross a Level.
 */
export const richContent: Content = {
	...sliceContent,
	start: { ...sliceContent.start, coins: 2_000 },
	silo: { capacity: 100_000 },
	barn: { capacity: 4 },
	crops: { wheat: { ...sliceContent.crops.wheat, xp: 31 } },
	facilities: sliceContent.facilities.map((facility) => ({
		...facility,
		recipes: Object.fromEntries(
			Object.entries(facility.recipes).map(([id, recipe]) => [id, { ...recipe, xp: richJobXp }]),
		),
	})),
};
