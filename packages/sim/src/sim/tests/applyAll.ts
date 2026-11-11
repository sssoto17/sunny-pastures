import { createSim, sliceContent } from "../../index.js";
import type { Action, FarmState } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";

const sim = createSim(sliceContent);

/** Applies `actions` to a slice farm in turn, each at its time; fails the test on a refusal. */
export function applyAll(farm: FarmState, actions: readonly [Action, number][]): FarmState {
	return actions.reduce(
		(current, [action, at]) => expectAccepted(sim.apply(current, action, at)),
		farm,
	);
}
