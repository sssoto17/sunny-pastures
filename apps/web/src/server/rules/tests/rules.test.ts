import { describe, expect, it } from "vitest";

import { createSim, sliceContent, stateHash } from "@sunny-pastures/sim";
import type { FarmState } from "@sunny-pastures/sim";

import { createRules } from "../index";
import type { LoggedAction } from "../index";

const farmId = "farm-1";

/** Accepted on a new slice farm in this order: wheat grows for 120 s (`sliceContent`). */
const log: readonly LoggedAction[] = [
	{ seq: 1, at: 1_000, action: { type: "plant", plot: 0, crop: "wheat" } },
	{ seq: 2, at: 5_000, action: { type: "plant", plot: 1, crop: "wheat" } },
	{ seq: 3, at: 121_000, action: { type: "harvest", plot: 0 } },
	{ seq: 4, at: 130_000, action: { type: "plant", plot: 0, crop: "wheat" } },
	{ seq: 5, at: 200_000, action: { type: "harvest", plot: 1 } },
];

/** An hour in: the replanted wheat has ripened offline, after the last logged action. */
const to = 3_600_000;

describe("createRules", () => {
	const rules = createRules(sliceContent);

	it("is rules version 1, the one version M3 has (ADR-0006, section 2)", () => {
		expect(rules.rulesVersion).toBe(1);
	});

	it("builds the sim's new farm for an id, seeded from it (MUST-10.3)", () => {
		const sim = createSim(sliceContent);

		expect(rules.newFarm(farmId)).toEqual(sim.newFarm(farmId));
		expect(rules.newFarm(farmId).streams).not.toEqual(rules.newFarm("farm-2").streams);
	});
});

describe("replay", () => {
	const { newFarm, replay } = createRules(sliceContent);

	it("ends on the farm that applying the same actions live ends on", () => {
		const live = createSim(sliceContent).advance(playLive(log), to);

		const replayed = replay(newFarm(farmId), log, to);

		expect(stateHash(replayed)).toBe(stateHash(live));
		expect(replayed).toEqual(live);
		expect(replayed.time).toBe(to);
		expect(replayed.plots[0]).toEqual({ status: "ready", crop: "wheat" });
	});

	it("applies each logged action at its own `at`", () => {
		// `to` is the last row's `at`, so no later advance hides a row applied at another time.
		const lastAt = 200_000;

		const replayed = replay(newFarm(farmId), log, lastAt);

		expect(stateHash(replayed)).toBe(stateHash(playLive(log)));
		expect(replayed.time).toBe(lastAt);
	});

	it("throws when the rules refuse a logged action, naming its seq and the reason", () => {
		// Plot 2 was never planted, so the rules refuse to harvest it: a corrupt or forged log.
		const forged = [...log, { seq: 6, at: 210_000, action: { type: "harvest", plot: 2 } } as const];

		expect(() => replay(newFarm(farmId), forged, to)).toThrow(
			"refused the logged action at seq 6. Plot 3 isn't ready to harvest.",
		);
	});

	it("throws rather than skip a refused action in the middle of the log", () => {
		// Seq 3 harvests plot 0 a second before it ripens. Skipping it would leave the rows after it
		// replaying onto another farm, so a cheat could hide an action in the log (ADR-0001).
		const early = log.map((row) => (row.seq === 3 ? { ...row, at: 120_000 } : row));

		expect(() => replay(newFarm(farmId), early, to)).toThrow(/seq 3/);
	});

	it("throws when a logged action is before the farm's time", () => {
		const snapshot = playLive(log);

		const stale = { seq: 6, at: 1_000, action: { type: "plant", plot: 2, crop: "wheat" } } as const;

		expect(() => replay(snapshot, [stale], to)).toThrow(/seq 6.*before/);
	});

	it("ends on the same farm from a snapshot as from the first action", () => {
		// A snapshot after seq 2, through JSON as the store keeps it (ADR-0003: the state is plain data).
		const snapshot = JSON.parse(JSON.stringify(playLive(log.slice(0, 2)))) as FarmState;

		const fromSnapshot = replay(snapshot, log.slice(2), to);

		expect(stateHash(fromSnapshot)).toBe(stateHash(replay(newFarm(farmId), log, to)));
		expect(fromSnapshot).toEqual(replay(newFarm(farmId), log, to));
	});

	it("advances a farm with nothing logged after it to `to`", () => {
		const snapshot = playLive(log);

		expect(replay(snapshot, [], to)).toEqual(createSim(sliceContent).advance(snapshot, to));
	});

	it("throws when the rows aren't in seq order with no gaps", () => {
		const swapped = [log[1], log[0], ...log.slice(2)].filter((row) => row !== undefined);
		const gap = log.filter((row) => row.seq !== 2);

		expect(() => replay(newFarm(farmId), swapped, to)).toThrow("seq 1 after seq 2");
		expect(() => replay(newFarm(farmId), gap, to)).toThrow("seq 3 after seq 1");
	});
});

/** Applies `actions` to a new farm one by one through the sim itself, as the live loop does. */
function playLive(actions: readonly LoggedAction[]): FarmState {
	const sim = createSim(sliceContent);
	return actions.reduce((farm, { action, at }) => {
		const result = sim.apply(farm, action, at);
		if (!result.ok) throw new Error(`The test log was refused: ${result.reason}`);

		return result.state;
	}, sim.newFarm(farmId));
}
