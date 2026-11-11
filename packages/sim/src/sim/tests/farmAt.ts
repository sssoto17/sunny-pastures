import { createSim, sliceContent } from "../../index.js";
import type { FarmState } from "../../index.js";

const sim = createSim(sliceContent);

/** The slice's XP for `level`, from its Level table. */
export function xpOfLevel(level: number): number {
	return sliceContent.levels[level - 1]?.xp ?? 0;
}

/** A new slice farm at `level` with `coins`. */
export function farmAt(level: number, coins: number): FarmState {
	return { ...sim.newFarm("farm-1"), xp: xpOfLevel(level), coins };
}
