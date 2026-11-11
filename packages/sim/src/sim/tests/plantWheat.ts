import type { FarmState, Sim } from "../../index.js";
import { expectAccepted } from "./expectAccepted.js";

/** A new farm with wheat planted on plot 1 at `at`. */
export function plantWheat(sim: Sim, farmId: string, at = 0): FarmState {
	return expectAccepted(
		sim.apply(sim.newFarm(farmId), { type: "plant", plot: 0, crop: "wheat" }, at),
	);
}
