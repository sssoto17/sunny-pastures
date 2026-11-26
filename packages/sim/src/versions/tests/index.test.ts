import { describe, expect, it } from "vitest";

import { createSim, currentRulesVersion, sliceContent, stateHash } from "../../index.js";
import type { Action, FarmState } from "../../index.js";
import { createVersions, listVersions, registry } from "../index.js";
import type { LoggedRow } from "../index.js";
import { tunedContent, twoVersions } from "./twoVersions.js";

const farmId = "farm-1";
const plant = { type: "plant", plot: 0, crop: "wheat" } as const;
const harvest = { type: "harvest", plot: 0 } as const;
/** Wheat grows for 120 s under version 1 (`sliceContent`) and 150 s under version 2. */
const v1Ripe = 121_000;

const row = (seq: number, at: number, action: Action, rulesVersion = 1): LoggedRow => ({
	seq,
	at,
	action,
	rulesVersion,
});

describe("registry", () => {
	it("holds version 1, unreleased, with the content the client imports from the package entry", () => {
		expect(registry.first).toEqual({ content: sliceContent, contentHash: null });
		expect(createVersions(registry).current).toBe(1);
	});

	it("has the current version the package entry exports for the client (#667)", () => {
		expect(createVersions(registry).current).toBe(currentRulesVersion);
		expect(listVersions(registry).at(-1)?.content).toBe(sliceContent);
	});
});

describe("createVersions", () => {
	const versions = createVersions(twoVersions);

	it("makes the highest version the current one", () => {
		expect(versions.current).toBe(2);
	});

	it("gives each version its own content's sim", () => {
		const [v1, v2] = [1, 2].map((version) => versions.getSim(version).newFarm(farmId));

		expect(v1).toEqual(createSim(sliceContent).newFarm(farmId));
		expect(v2).toEqual(createSim(tunedContent).newFarm(farmId));
		expect(v2?.facilities).toHaveLength(3);
	});

	it.each([0, 3, 1.5, Number.NaN])(
		"throws for rules version %s, which it doesn't know",
		(version) => {
			expect(() => versions.getSim(version)).toThrow(`rules version ${String(version)} is unknown`);
		},
	);
});

describe("upgradeTo", () => {
	const versions = createVersions(twoVersions);
	const farm = { state: versions.getSim(1).newFarm(farmId), rulesVersion: 1 };

	it("runs each later version's upgrade on the way, unadvanced", () => {
		const upgraded = versions.upgradeTo(farm, 2);

		expect(upgraded.rulesVersion).toBe(2);
		expect(upgraded.state).toEqual({ ...farm.state, facilities: [null, null, null] });
	});

	it("leaves a farm already at the version as it is", () => {
		expect(versions.upgradeTo(farm, 1)).toEqual(farm);
	});

	it("throws rather than take a farm back a version, or to one it doesn't know", () => {
		const upgraded = versions.upgradeTo(farm, 2);

		expect(() => versions.upgradeTo(upgraded, 1)).toThrow("can't go back to version 1");
		expect(() => versions.upgradeTo(farm, 3)).toThrow("rules version 3 is unknown");
		expect(() => versions.upgradeTo({ ...farm, rulesVersion: 0 }, 2)).toThrow(
			"version 0 is unknown",
		);
	});
});

describe("replay", () => {
	const versions = createVersions(twoVersions);
	const sim1 = createSim(sliceContent);
	const sim2 = createSim(tunedContent);

	it("starts from newFarm under the first row's version, or the current one with no row", () => {
		expect(versions.replay(farmId, [], [])).toEqual({
			state: sim2.newFarm(farmId),
			rulesVersion: 2,
		});
		expect(versions.replay(farmId, [], [row(1, 1_000, plant)])).toEqual({
			state: applied(sim1, sim1.newFarm(farmId), plant, 1_000),
			rulesVersion: 1,
		});
	});

	it("gives the farm a version upgrade where a row's version steps up, then applies it under that version", () => {
		const log = [row(1, 1_000, plant), row(2, v1Ripe, harvest), row(3, 130_000, plant, 2)];

		const replayed = versions.replay(farmId, [], log);

		const before = applied(
			sim1,
			applied(sim1, sim1.newFarm(farmId), plant, 1_000),
			harvest,
			v1Ripe,
		);
		const upgraded = { ...before, facilities: [...before.facilities, null] };
		expect(replayed).toEqual({ state: applied(sim2, upgraded, plant, 130_000), rulesVersion: 2 });
	});

	it("replays a version 2 row under version 2's content: wheat planted under it isn't ripe at 120 s", () => {
		const log = [row(1, 1_000, plant, 2), row(2, v1Ripe, harvest, 2)];

		expect(() => versions.replay(farmId, [], log)).toThrow(
			"refused the logged action at seq 2. Plot 1 isn't ready to harvest.",
		);
	});

	it("throws a store error for a row whose version is lower than the farm's", () => {
		const log = [row(1, 1_000, plant, 2), row(2, 200_000, harvest, 1)];

		expect(() => versions.replay(farmId, [], log)).toThrow(
			"seq 2 has rules version 1, below the farm's 2",
		);
	});

	it("throws a store error for a row or a snapshot under a version it doesn't know", () => {
		const farm = sim1.newFarm(farmId);

		expect(() => versions.replay(farmId, [], [row(1, 1_000, plant, 3)])).toThrow(
			"rules version 3 is unknown",
		);
		expect(() => versions.replay(farmId, [{ seq: 1, rulesVersion: 3, state: farm }], [])).toThrow(
			"rules version 3 is unknown",
		);
	});

	it("throws on a gap or a step back in the seqs", () => {
		expect(() => versions.replay(farmId, [], [row(2, 1_000, plant)])).toThrow(
			"seq 2 where seq 1 belongs",
		);
		expect(() => versions.replay(farmId, [], [row(1, 1_000, plant), row(1, 2_000, plant)])).toThrow(
			"seq 1 where seq 2 belongs",
		);
	});

	it("starts from the newest snapshot, and skips the rows at or before it", () => {
		const after1 = applied(sim1, sim1.newFarm(farmId), plant, 1_000);
		const snapshots = [
			{ seq: 1, rulesVersion: 1, state: after1 },
			{ seq: 0, rulesVersion: 1, state: sim1.newFarm("another farm") },
		];
		const log = [row(1, 1_000, plant), row(2, v1Ripe, harvest)];

		const replayed = versions.replay(farmId, snapshots, log);

		expect(replayed).toEqual(versions.replay(farmId, [], log));
	});

	it("takes the higher version's snapshot at one seq: the base snapshot over the farm before its upgrade", () => {
		const after1 = applied(sim1, sim1.newFarm(farmId), plant, 1_000);
		const base = { seq: 1, ...versions.upgradeTo({ state: after1, rulesVersion: 1 }, 2) };
		// Marked, so the test sees which snapshot the replay started from.
		const marked = { ...base, state: { ...base.state, coins: base.state.coins + 7 } };

		const replayed = versions.replay(
			farmId,
			[marked, { seq: 1, rulesVersion: 1, state: after1 }],
			[],
		);

		expect(replayed).toEqual({ state: marked.state, rulesVersion: 2 });
		expect(stateHash(replayed.state)).not.toBe(stateHash(base.state));
	});
});

/** The farm after `action`, applied live; throws if the rules refuse it. */
function applied(
	sim: ReturnType<typeof createSim>,
	farm: FarmState,
	action: Action,
	at: number,
): FarmState {
	const result = sim.apply(farm, action, at);
	if (!result.ok) throw new Error(`The test action was refused: ${result.reason}`);

	return result.state;
}
