// The rules versions (ADR-0006): a registry of each version's content and version upgrade, and the
// replay that reads a log across versions. Server-only (ADR-0006, "The client"): the package entry
// (src/index.ts) doesn't export this module, so the client gets only the current content.
// Patterns: Registry (version → content and `upgrade`, section 2), Upcaster chained one version at
// a time (section 6), Event Sourcing replay with a version step (section 5). Rejected: keeping old
// sim builds side by side (section 8) and tolerant reading without a version upgrade (section 6).
import { sliceContent } from "../content/index.js";
import type { Content } from "../content/index.js";
import { createSim } from "../sim/index.js";
import type { Sim } from "../sim/index.js";
import type { Action, FarmState } from "../state/index.js";

/** One rules version's entry in the registry (ADR-0006, section 2). */
export interface RulesVersion {
	readonly content: Content;
	/**
	 * `stateHash(content)`, recorded when the version is released (first reaches an environment
	 * whose farms persist), or null while it is unreleased and its content may still change. Once
	 * set, the content is frozen: the rules-version check fails if it no longer hashes to this.
	 */
	readonly contentHash: string | null;
}

/** A rules version after the first: it brings farms from the version before it (section 6). */
export interface LaterVersion extends RulesVersion {
	/**
	 * Brings a farm in the previous version's shape to this version's: by default it fills new
	 * plots, facilities, pens and goods from content and changes nothing else. Under ADR-0003's
	 * rules (pure, integer-only, plain JSON) and total: it never throws.
	 */
	readonly upgrade: (farm: FarmState) => FarmState;
	/**
	 * The facts both versions share that `upgrade` changes on purpose (section 6), such as coins
	 * when an excess is converted. The rules-version check holds every other shared fact unchanged.
	 */
	readonly changes: readonly (keyof FarmState)[];
}

/** Every rules version, 1 first: `later[i]` is version i + 2, and the highest is the current one. */
export interface Registry {
	readonly first: RulesVersion;
	readonly later: readonly LaterVersion[];
}

/** A farm with the rules version its shape belongs to (the state itself carries none, ADR-0003). */
export interface VersionedFarm {
	readonly state: FarmState;
	readonly rulesVersion: number;
}

/** A stored snapshot: the farm after action `seq`, under the version it was written with. */
export interface VersionedSnapshot extends VersionedFarm {
	readonly seq: number;
}

/** One log row: an action accepted at `at` (ms) as action `seq`, under `rulesVersion`. */
export interface LoggedRow {
	readonly seq: number;
	readonly at: number;
	readonly action: Action;
	readonly rulesVersion: number;
}

/** The registry's versions as rules (ADR-0006, sections 5 and 6). Every throw is a store error. */
export interface Versions {
	/** The highest version: the one new actions are accepted and written under. */
	readonly current: number;
	/** The sim for `version`. Throws for a version the registry doesn't hold (section 8). */
	simOf(version: number): Sim;
	/**
	 * Gives `farm` a version upgrade to `to`, one version at a time (section 6), unadvanced. Returns
	 * the same farm when it is already at `to`. Throws for an unknown version or a `to` below the
	 * farm's: versions only go forward (section 8).
	 */
	upgradeTo(farm: VersionedFarm, to: number): VersionedFarm;
	/**
	 * Applies one row (section 5, steps 2 and 3): a version upgrade first if the row's version is
	 * higher than the farm's, then the action at its `at` under the row's version. Throws for a row
	 * whose version is lower than the farm's or unknown, and for an action the rules refuse.
	 */
	applyRow(farm: VersionedFarm, row: LoggedRow): VersionedFarm;
	/**
	 * Replays a farm's log (section 5, steps 1 to 3): from the newest snapshot, the higher version
	 * winning at one seq, or else `newFarm(farmId)` under the first row's version (the current one if
	 * there is no row), then every row after it in seq order. Rows at or before the snapshot's seq
	 * are skipped. Ends at the last row, unadvanced and under its version; `load` then gives it a
	 * version upgrade to `current` (step 4). Throws as `applyRow` does, and on a gap in the seqs.
	 */
	replay(
		farmId: string,
		snapshots: readonly VersionedSnapshot[],
		rows: readonly LoggedRow[],
	): VersionedFarm;
}

/**
 * The game's registry. Version 1 is the slice content, unreleased until the first deploy whose
 * farms persist (M4's, ADR-0007 section 1): releasing it records its hash here, and the recording
 * script then records its logs (`scripts/record-rules-version.mjs`). A tuning after that adds a
 * version; it never edits a released one.
 */
export const registry: Registry = {
	first: { content: sliceContent, contentHash: null },
	later: [],
};

export function createVersions({ first, later }: Registry): Versions {
	const sims = [first, ...later].map(({ content }) => createSim(content));
	const current = sims.length;

	function simOf(version: number): Sim {
		const sim = Number.isSafeInteger(version) ? sims[version - 1] : undefined;
		if (sim === undefined) {
			// An instance older than the farm's version (a deploy's overlap) answers 503 (section 8).
			throw new Error(
				`Replay error: rules version ${String(version)} is unknown here, which knows 1 to ${String(current)}.`,
			);
		}

		return sim;
	}

	function upgradeTo(farm: VersionedFarm, to: number): VersionedFarm {
		simOf(farm.rulesVersion);
		simOf(to);
		if (to < farm.rulesVersion) {
			throw new Error(
				`Replay error: a farm at rules version ${String(farm.rulesVersion)} can't go back to version ${String(to)}.`,
			);
		}

		// later[i] is version i + 2, so the steps from version v up to `to` are later[v - 1 .. to - 2].
		const steps = later.slice(farm.rulesVersion - 1, to - 1);
		const state = steps.reduce((upgraded, { upgrade }) => upgrade(upgraded), farm.state);
		return { state, rulesVersion: to };
	}

	function applyRow(
		farm: VersionedFarm,
		{ seq, at, action, rulesVersion }: LoggedRow,
	): VersionedFarm {
		if (rulesVersion < farm.rulesVersion) {
			// Versions never decrease along a log, so a step back is a corrupt log (section 5, step 3).
			throw new Error(
				`Replay error: seq ${String(seq)} has rules version ${String(rulesVersion)}, below the farm's ${String(farm.rulesVersion)}.`,
			);
		}

		const { state } = upgradeTo(farm, rulesVersion);
		const result = simOf(rulesVersion).apply(state, action, at);
		if (!result.ok) {
			throw new Error(
				`Replay error: the rules refused the logged action at seq ${String(seq)}. ${result.reason}`,
			);
		}

		return { state: result.state, rulesVersion };
	}

	return {
		current,
		simOf,
		upgradeTo,
		applyRow,
		replay(farmId, snapshots, rows) {
			const snapshot = findNewest(snapshots);
			const fromSeq = snapshot?.seq ?? 0;
			const after = rows.filter((row) => row.seq > fromSeq);
			let farm: VersionedFarm;
			if (snapshot === null) {
				const rulesVersion = after[0]?.rulesVersion ?? current;
				farm = { state: simOf(rulesVersion).newFarm(farmId), rulesVersion };
			} else {
				simOf(snapshot.rulesVersion);
				farm = { state: snapshot.state, rulesVersion: snapshot.rulesVersion };
			}

			for (const [i, row] of after.entries()) {
				const expected = fromSeq + i + 1;
				if (row.seq !== expected) {
					// A gap is a lost action and a step back a reordered log: either replays into another farm.
					throw new Error(
						`Replay error: the log has seq ${String(row.seq)} where seq ${String(expected)} belongs.`,
					);
				}

				farm = applyRow(farm, row);
			}
			return farm;
		},
	};
}

/** The newest snapshot: the highest seq, and at one seq the higher version (section 5, step 1). */
function findNewest(snapshots: readonly VersionedSnapshot[]): VersionedSnapshot | null {
	let newest: VersionedSnapshot | null = null;
	for (const snapshot of snapshots) {
		const isNewer =
			newest === null ||
			snapshot.seq > newest.seq ||
			(snapshot.seq === newest.seq && snapshot.rulesVersion > newest.rulesVersion);
		if (isNewer) newest = snapshot;
	}
	return newest;
}
