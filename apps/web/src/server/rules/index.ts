import "server-only";

import type { FarmState, Sim } from "@sunny-pastures/sim";
import {
	createVersions,
	type LoggedRow,
	type Registry,
	type VersionedSnapshot,
} from "@sunny-pastures/sim/versions";

/**
 * The rules for the rest of the server (ADR-0007, section 2): a Facade over the rules-version
 * registry (ADR-0006, section 2) → the current version's sim, `newFarm` and a versioned `replay`.
 * The registry replaced M3's one sim behind the same interface (#535): the routes still see the
 * current version's `sim` and `rulesVersion`. `newFarm` and `replay` are plain functions, not
 * methods, because the store is handed them on their own (#373).
 */
export interface Rules {
	/** The registry's current version: new actions are accepted, and stamped, under it (ADR-0006). */
	readonly rulesVersion: number;
	/** The current version's sim. */
	readonly sim: Sim;
	/** A new farm for `farmId` under the current version, seeded from the id (MUST-10.3; D9). */
	readonly newFarm: (farmId: string) => FarmState;
	/**
	 * Replays a farm's log (ADR-0006, section 5): from `snapshot` (or `newFarm` under the first
	 * row's version when there is none), each row at its own `at` under its own `rulesVersion`, with
	 * a version upgrade where the version steps up, then a version upgrade to the current version.
	 * Unadvanced: the farm comes back at the last row's time, or the snapshot's with no row after it
	 * (ADR-0006, section 4: the handler advances it). Rows at or before the snapshot's seq are
	 * skipped.
	 *
	 * Throws, and never skips a row, on: a refused action (a corrupt log or other rules; ADR-0001), a
	 * seq that isn't the one after the snapshot's or the row before it, a row whose version is below
	 * the farm's, and a version this code doesn't know (an instance older than the farm, section 8).
	 * The store treats every throw as a store error, which the handler answers with a 503.
	 */
	readonly replay: (
		farmId: string,
		snapshot: VersionedSnapshot | null,
		rows: readonly LoggedRow[],
	) => FarmState;
}

/** Builds the rules from the registry; the composition root hands in the game's (`registry`). */
export function createRules(registry: Registry): Rules {
	const versions = createVersions(registry);
	const { current } = versions;
	const sim = versions.getSim(current);
	return {
		rulesVersion: current,
		sim,
		newFarm: (farmId) => sim.newFarm(farmId),
		replay(farmId, snapshot, rows) {
			const replayed = versions.replay(farmId, snapshot === null ? [] : [snapshot], rows);
			// `load` ends at the current version, so the rules only see their own shape (ADR-0006,
			// section 5, step 4).
			return versions.upgradeTo(replayed, current).state;
		},
	};
}
