import "server-only";

import {
	createSim,
	type Action,
	type Content,
	type FarmState,
	type Sim,
} from "@sunny-pastures/sim";

/**
 * The rules for the rest of the server (ADR-0007, section 2): a Facade over content → sim,
 * `newFarm` and `replay`, with a Strategy slot behind it. M3 has one rules version; M4's registry
 * (#154) replaces what `createRules` builds without changing this interface. `newFarm` and
 * `replay` are plain functions, not methods, because the store is handed them on their own (#373).
 */
export interface Rules {
	/** The rules version these rules are, written on every log row and snapshot (ADR-0006). */
	readonly rulesVersion: number;
	readonly sim: Sim;
	/** A new farm for `farmId`, its random streams seeded from the id (MUST-10.3; ADR-0003, D9). */
	readonly newFarm: (farmId: string) => FarmState;
	/**
	 * Replays a farm's log (ADR-0001, "Store interface"): applies `actions` to `state` in
	 * order, each at its own `at`, then advances to `to`. `state` is a snapshot's farm, or
	 * `newFarm` when the farm has none, and `actions` are the rows logged after it. A `to` before
	 * the last row's `at` doesn't throw: the farm comes back at that row's time, as `advance` never
	 * goes back (ADR-0003, D7).
	 *
	 * Throws if the rules refuse a logged action, and never skips one: every row was accepted once,
	 * so a refusal means a corrupt log or other rules, and skipping it would replay into another farm
	 * (ADR-0001; ADR-0006, section 5, step 3). Throws too if `actions` aren't in seq order with no
	 * gaps; the first row isn't checked against the snapshot's seq, which `state` doesn't carry, so
	 * the store checks that boundary itself (#443). The store treats either throw as a store error.
	 */
	readonly replay: (state: FarmState, actions: readonly LoggedAction[], to: number) => FarmState;
}

/** One accepted action as the log keeps it: the row type the store hands to `replay` (#373). */
export interface LoggedAction {
	/** The action's sequence number in its farm's history: 1, 2, 3 with no gaps. */
	readonly seq: number;
	/** The server time the action took effect at, in ms. */
	readonly at: number;
	readonly action: Action;
}

/** The one rules version M3 has (ADR-0006, section 2). */
const rulesVersion = 1;

export function createRules(content: Content): Rules {
	const sim = createSim(content);
	return {
		rulesVersion,
		sim,
		newFarm: (farmId) => sim.newFarm(farmId),
		replay: (state, actions, to) => sim.advance(applyLogged(sim, state, actions), to),
	};
}

/** Folds `apply` over the rows; throws on a gap in the seqs or on a refusal, never skips a row. */
function applyLogged(sim: Sim, state: FarmState, actions: readonly LoggedAction[]): FarmState {
	let farm = state;
	for (const [i, { seq, action, at }] of actions.entries()) {
		const previous = actions[i - 1];
		if (previous !== undefined && seq !== previous.seq + 1) {
			// A gap is a lost action and a step back is a reordered log: either replays into another farm.
			throw new Error(
				`Replay error: the log has seq ${String(seq)} after seq ${String(previous.seq)}.`,
			);
		}

		const result = sim.apply(farm, action, at);
		if (!result.ok) {
			throw new Error(
				`Replay error: the rules refused the logged action at seq ${String(seq)}. ${result.reason}`,
			);
		}

		farm = result.state;
	}
	return farm;
}
