// The slice's facilities and recipes (#84), written out for the job and add-on tests rather than
// read from content, so the expected values don't recompute what the rules do.
import { createSim, sliceContent } from "../../index.js";
import type { Action, FarmState } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";

const sim = createSim(sliceContent);

/** Chicken feed takes 2 wheat and 60 s for 2 feed and 1 XP; bread 3 wheat and 300 s for 1 and 2 XP. */
export const feedMs = 60_000;
export const breadMs = 300_000;

export const feedMill = 0;
export const bakery = 1;
export const startFeed = { type: "startJob", facility: feedMill, recipe: "chickenFeed" } as const;
export const startBread = { type: "startJob", facility: bakery, recipe: "bread" } as const;

/** Applies `actions` to the slice's farm in turn, each at its time; fails the test on a refusal. */
export function applyAll(farm: FarmState, actions: readonly [Action, number][]): FarmState {
	return actions.reduce(
		(current, [action, at]) => expectAccepted(sim.apply(current, action, at)),
		farm,
	);
}
