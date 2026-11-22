// Each assertion of the rules-version check finds the fault it is for (#154), so a green check
// means something: an edited released version, a log that no longer replays, a version upgrade
// that throws, breaks a bound or loses a fact, and an impure one that breaks the base snapshot.
import { describe, expect, inject, it, vi } from "vitest";

import { sliceContent, stateHash } from "../../index.js";
import type { FarmState } from "../../index.js";
import { requireProvided } from "../../state/tests/provided.js";
import { createVersions } from "../index.js";
import type { LaterVersion, Registry } from "../index.js";
import {
	listBoundaryFaults,
	listFrozenFaults,
	listInvariantFaults,
	listReplayFaults,
	listUpgradeFaults,
} from "./check.js";
import { recordLogs } from "./record.js";
import { tunedContent, twoVersions } from "./twoVersions.js";

const params = requireProvided("fastCheck", inject("fastCheck"));
// #208: this file records logs with the property settings, so it takes their timeout too.
vi.setConfig({ testTimeout: inject("propertyTimeout") });
const recording = recordLogs(twoVersions, 1, params);
const [log] = recording.logs;
const [tuned] = twoVersions.later;
const newFarm = createVersions(twoVersions).simOf(1).newFarm("farm-1");

/** `twoVersions` with version 2's entry changed. */
const withTuned = (change: Partial<LaterVersion>): Registry => ({
	...twoVersions,
	later: tuned === undefined ? [] : [{ ...tuned, ...change }],
});

describe("listFrozenFaults", () => {
	it("finds a released version whose content changed after its hash was recorded", () => {
		const edited = {
			...twoVersions,
			first: { content: tunedContent, contentHash: stateHash(sliceContent) },
		};

		expect(listFrozenFaults(edited)).toEqual([
			"version 1's content no longer hashes to its recorded hash",
		]);
	});

	it("finds a version released after an unreleased one", () => {
		const skipped = withTuned({ contentHash: stateHash(tunedContent) });

		expect(
			listFrozenFaults({ ...skipped, first: { content: sliceContent, contentHash: null } }),
		).toEqual(["version 2 is released after an unreleased version"]);
	});
});

describe("listReplayFaults", () => {
	it("records logs with actions in them", () => {
		expect(recording.logs.length).toBeGreaterThan(0);
		expect(log?.rows.length).toBeGreaterThan(0);
	});

	it("finds a row whose recorded hash today's code no longer reaches", () => {
		const [first, ...rest] = log?.rows ?? [];
		if (log === undefined || first === undefined) throw new Error("The recording has no row.");

		const moved = { ...log, rows: [{ ...first, hash: "0".repeat(64) }, ...rest] };

		expect(listReplayFaults(twoVersions, { ...recording, logs: [moved] })).toEqual([
			`${log.farmId}: seq 1 replays to another farm`,
		]);
	});

	it("finds a final farm whose recorded hash today's code no longer reaches", () => {
		if (log === undefined) throw new Error("The recording has no log.");

		const moved = { ...log, hash: "0".repeat(64) };

		expect(listReplayFaults(twoVersions, { ...recording, logs: [moved] })).toEqual([
			`${log.farmId}: the farm after its last row replays to another farm`,
		]);
	});

	it("finds logs that replay differently, or not at all, when version 1's content is tuned in place", () => {
		const edited = { ...twoVersions, first: { content: tunedContent, contentHash: null } };

		expect(listReplayFaults(edited, recording).length).toBeGreaterThan(0);
	});
});

describe("listUpgradeFaults", () => {
	it("finds a version upgrade that throws", () => {
		const throwing = withTuned({
			upgrade: () => {
				throw new Error("No room for the new mill.");
			},
		});

		expect(listUpgradeFaults(throwing, 1, newFarm)).toEqual([
			"1 → 2 throws: No room for the new mill.",
		]);
	});

	it("finds a shared fact changed without being declared, and accepts it once declared", () => {
		const taxing = (farm: FarmState): FarmState => ({
			...farm,
			coins: farm.coins - 1,
			facilities: [...farm.facilities, null],
		});

		expect(listUpgradeFaults(withTuned({ upgrade: taxing }), 1, newFarm)).toEqual([
			"1 → 2: it changed the shared fact coins",
		]);
		expect(
			listUpgradeFaults(withTuned({ upgrade: taxing, changes: ["coins"] }), 1, newFarm),
		).toEqual([]);
	});

	it("finds a farm that doesn't fit the new version's content, or isn't plain JSON", () => {
		const forgetful = withTuned({ upgrade: (farm) => farm });
		const lossy = withTuned({
			upgrade: (farm) =>
				({
					...farm,
					facilities: [...farm.facilities, null],
					xp: undefined,
				}) as unknown as FarmState,
		});

		expect(listUpgradeFaults(forgetful, 1, newFarm)).toEqual([
			"1 → 2: a facility entry per content facility",
		]);
		expect(listUpgradeFaults(lossy, 1, newFarm)).toContain(
			"1 → 2: it doesn't survive a JSON round trip",
		);
	});
});

describe("listInvariantFaults", () => {
	it("finds each of MUST-14.4's bounds broken", () => {
		const broken: FarmState = {
			...newFarm,
			coins: -1,
			silo: { wheat: sliceContent.silo.capacity + 1 },
			barn: { eggs: 0 },
			time: 0.5,
			plots: Array.from({ length: 99 }, () => ({ status: "empty" }) as const),
			board: Array.from({ length: 33 }, () => newFarm.board).flat(),
			pens: [{ trough: 9, animals: [], products: -1 }],
			facilities: [
				{ tier: 9, jobs: [], lastRecipe: null, addOns: { loop: false, collector: false } },
				null,
			],
		};

		expect(listInvariantFaults(broken, sliceContent)).toEqual([
			"$.time is 0.5, not a safe integer",
			"coins or XP below 0",
			"the silo holds more than its capacity",
			"the barn keeps a count of 0 or less",
			"more plots than content allows",
			"more order slots than content gives",
			"facility 0's queue is over its tier's slots",
			"pen 0 is out of its bounds",
		]);
	});
});

describe("listBoundaryFaults", () => {
	it("finds an impure version upgrade, whose base snapshot holds another farm than a replay from the first action", () => {
		let calls = 0;
		const counting = withTuned({
			upgrade: (farm) => {
				calls += 1;
				return { ...farm, xp: farm.xp + calls, facilities: [...farm.facilities, null] };
			},
		});
		if (log === undefined) throw new Error("The recording has no log.");

		expect(listBoundaryFaults(counting, 1, log, [])).toEqual([
			`${log.farmId}: the replay from the base snapshot ends on another farm`,
		]);
		expect(listBoundaryFaults(twoVersions, 1, log, [])).toEqual([]);
	});
});
