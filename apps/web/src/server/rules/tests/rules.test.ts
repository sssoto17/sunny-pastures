import { describe, expect, it } from "vitest";

import { createSim, sliceContent, stateHash } from "@sunny-pastures/sim";
import type { Content, FarmState } from "@sunny-pastures/sim";
import { registry } from "@sunny-pastures/sim/versions";
import type { LoggedRow, Registry } from "@sunny-pastures/sim/versions";

import { createRules } from "../index";

const farmId = "farm-1";

/** Accepted on a new slice farm in this order under version 1: wheat grows for 120 s. */
const log: readonly LoggedRow[] = [
	{ seq: 1, at: 1_000, action: { type: "plant", plot: 0, crop: "wheat" }, rulesVersion: 1 },
	{ seq: 2, at: 5_000, action: { type: "plant", plot: 1, crop: "wheat" }, rulesVersion: 1 },
	{ seq: 3, at: 121_000, action: { type: "harvest", plot: 0 }, rulesVersion: 1 },
	{ seq: 4, at: 130_000, action: { type: "plant", plot: 0, crop: "wheat" }, rulesVersion: 1 },
	{ seq: 5, at: 200_000, action: { type: "harvest", plot: 1 }, rulesVersion: 1 },
];

/** Version 2 of a test registry: wheat grows 30 s longer (150 s). */
const slowWheat: Content = {
	...sliceContent,
	crops: {
		...sliceContent.crops,
		wheat: { ...sliceContent.crops.wheat, growSeconds: sliceContent.crops.wheat.growSeconds + 30 },
	},
};

/** Version 2's upgrade gives 7 coins, so a test can see where it ran (ADR-0006, section 6). */
const upgradeCoins = 7;

/** The slice as version 1 and a tuning as version 2, so replay has a version step to cross. */
const twoVersions: Registry = {
	first: registry.first,
	later: [
		{
			content: slowWheat,
			contentHash: null,
			upgrade: (farm) => ({ ...farm, coins: farm.coins + upgradeCoins }),
			changes: ["coins"],
		},
	],
};

describe("createRules", () => {
	it("is the registry's current version: 1 for the game's registry (ADR-0006, section 2)", () => {
		expect(createRules(registry).rulesVersion).toBe(1);
		expect(createRules(twoVersions).rulesVersion).toBe(2);
	});

	it("runs the current version's content: wheat isn't ripe at 120 s under version 2", () => {
		const { sim, newFarm } = createRules(twoVersions);
		const planted = sim.apply(newFarm(farmId), { type: "plant", plot: 0, crop: "wheat" }, 0);
		if (!planted.ok) throw new Error(planted.reason);

		expect(sim.apply(planted.state, { type: "harvest", plot: 0 }, 120_000).ok).toBe(false);
		expect(sim.apply(planted.state, { type: "harvest", plot: 0 }, 150_000).ok).toBe(true);
	});

	it("builds the sim's new farm for an id, seeded from it (MUST-10.3)", () => {
		const { newFarm } = createRules(registry);

		expect(newFarm(farmId)).toEqual(createSim(sliceContent).newFarm(farmId));
		expect(newFarm(farmId).streams).not.toEqual(newFarm("farm-2").streams);
	});
});

describe("replay", () => {
	const { replay } = createRules(registry);

	it("ends on the farm that applying the same actions live ends on, at the last row's time", () => {
		const replayed = replay(farmId, null, log);

		expect(stateHash(replayed)).toBe(stateHash(playLive(log)));
		expect(replayed).toEqual(playLive(log));
		expect(replayed.time).toBe(200_000);
	});

	it("ends on the same farm from a snapshot as from the first action", () => {
		// A snapshot after seq 2, through JSON as the store keeps it (ADR-0003: plain data).
		const state = JSON.parse(JSON.stringify(playLive(log.slice(0, 2)))) as FarmState;

		const fromSnapshot = replay(farmId, { seq: 2, state, rulesVersion: 1 }, log.slice(2));

		expect(fromSnapshot).toEqual(replay(farmId, null, log));
	});

	it("gives back a snapshot with no row after it unadvanced", () => {
		const state = playLive(log);

		expect(replay(farmId, { seq: 5, state, rulesVersion: 1 }, [])).toEqual(state);
	});

	it("gives back a new farm for a farm with no snapshot and no row", () => {
		expect(replay(farmId, null, [])).toEqual(createSim(sliceContent).newFarm(farmId));
	});

	it("throws when the rules refuse a logged action, naming its seq and the reason", () => {
		// Plot 2 was never planted, so the rules refuse to harvest it: a corrupt or forged log.
		const forged = [...log, { ...harvest(6, 210_000, 2), rulesVersion: 1 }];

		expect(() => replay(farmId, null, forged)).toThrow(
			"refused the logged action at seq 6. Plot 3 isn't ready to harvest.",
		);
	});

	it("throws rather than skip a refused action in the middle of the log", () => {
		// Seq 3 harvests plot 0 a second before it ripens. Skipping it would leave the rows after it
		// replaying onto another farm, so a cheat could hide an action in the log (ADR-0001).
		const early = log.map((row) => (row.seq === 3 ? { ...row, at: 120_000 } : row));

		expect(() => replay(farmId, null, early)).toThrow(/seq 3/);
	});

	it("throws when the rows have a gap, after the snapshot or between rows", () => {
		const state = playLive(log.slice(0, 2));

		expect(() => replay(farmId, null, log.slice(1))).toThrow("seq 2 where seq 1 belongs");
		expect(() => replay(farmId, { seq: 2, state, rulesVersion: 1 }, log.slice(3))).toThrow(
			"seq 4 where seq 3 belongs",
		);
	});

	it("throws a store error for a row or a snapshot under a version it doesn't know (ADR-0006, section 8)", () => {
		const fromNext = log.map((row) => (row.seq === 5 ? { ...row, rulesVersion: 2 } : row));
		const state = playLive(log);

		expect(() => replay(farmId, null, fromNext)).toThrow("rules version 2 is unknown here");
		expect(() => replay(farmId, { seq: 5, state, rulesVersion: 2 }, [])).toThrow(
			"rules version 2 is unknown here",
		);
	});
});

describe("replay across rules versions", () => {
	const { replay } = createRules(twoVersions);

	it("ends with a version upgrade to the current version, unadvanced (ADR-0006, section 5, step 4)", () => {
		const replayed = replay(farmId, null, log);
		const live = playLive(log);

		expect(replayed).toEqual({ ...live, coins: live.coins + upgradeCoins });
		expect(replayed.time).toBe(200_000);
	});

	it("upgrades a snapshot of the previous version with no row after it", () => {
		const state = playLive(log);

		expect(replay(farmId, { seq: 5, state, rulesVersion: 1 }, [])).toEqual({
			...state,
			coins: state.coins + upgradeCoins,
		});
	});

	it("doesn't upgrade a base snapshot already at the current version", () => {
		const state = playLive(log);

		expect(replay(farmId, { seq: 5, state, rulesVersion: 2 }, [])).toEqual(state);
	});

	it("applies each row under its own version: a version 2 harvest at 120 s is refused", () => {
		const plant = { seq: 1, at: 1_000, action: { type: "plant", plot: 0, crop: "wheat" } } as const;
		const version1 = [
			{ ...plant, rulesVersion: 1 },
			{ ...harvest(2, 121_000, 0), rulesVersion: 1 },
		];
		const version2 = [
			{ ...plant, rulesVersion: 2 },
			{ ...harvest(2, 121_000, 0), rulesVersion: 2 },
		];

		expect(() => replay(farmId, null, version1)).not.toThrow();
		expect(() => replay(farmId, null, version2)).toThrow(/seq 2/);
	});

	it("throws a store error for a row whose version is below the farm's (ADR-0006, section 5, step 3)", () => {
		const state = playLive(log.slice(0, 2));

		expect(() => replay(farmId, { seq: 2, state, rulesVersion: 2 }, log.slice(2))).toThrow(
			"seq 3 has rules version 1, below the farm's 2",
		);
	});
});

function harvest(seq: number, at: number, plot: number) {
	return { seq, at, action: { type: "harvest", plot } } as const;
}

/** Applies `rows` to a new farm one by one through the slice's sim, as the live loop does. */
function playLive(rows: readonly LoggedRow[]): FarmState {
	const sim = createSim(sliceContent);
	return rows.reduce((farm, { action, at }) => {
		const result = sim.apply(farm, action, at);
		if (!result.ok) throw new Error(`The test log was refused: ${result.reason}`);

		return result.state;
	}, sim.newFarm(farmId));
}
