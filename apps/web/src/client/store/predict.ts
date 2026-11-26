import type { FarmState, Sim } from "@sunny-pastures/sim";

import type { FarmEnvelope } from "@/contract";

import type { PendingAction } from "./pending";

/**
 * The predicted farm (ADR-0010, section 4; MUST-12.2): the confirmed farm with each pending action
 * applied in order at its time, then advanced to `now`. An action is applied no earlier than the
 * farm's time, since the server's farm can be ahead of the client's clock. An action the rules now
 * refuse stays pending but is left out: the server's answer decides it.
 */
export function predict(
	sim: Sim,
	confirmed: FarmEnvelope,
	pending: readonly PendingAction[],
	now: number,
): FarmState {
	let farm = confirmed.state;
	for (const { action, at } of pending) {
		const result = sim.apply(farm, action, Math.max(at, farm.time));
		if (result.ok) farm = result.state;
	}
	return sim.advance(farm, now);
}
