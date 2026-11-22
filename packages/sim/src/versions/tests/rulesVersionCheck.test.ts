// The rules-version check (ADR-0006, section 10; #154): for every released version, frozen
// content, recorded logs that still replay, total version upgrades that keep the farm, and the same
// farm across a boundary from the first action or from a base snapshot. It runs over the game's
// registry and over a registry with a boundary in it (twoVersions.ts), recorded here, so the
// assertions are exercised before the game's first release gives them a version to hold.
import fc from "fast-check";
import { describe, expect, inject, it, vi } from "vitest";

import { farmId, play, timedActions } from "../../state/tests/farms.js";
import { requireProvided } from "../../state/tests/provided.js";
import { createVersions, listVersions, registry } from "../index.js";
import type { Registry } from "../index.js";
import {
	listBoundaryFaults,
	listFrozenFaults,
	listReplayFaults,
	listUpgradeFaults,
} from "./check.js";
import { recordLogs } from "./record.js";
import type { Recording } from "./record.js";
import { recordings } from "./recordings.js";
import { twoVersions } from "./twoVersions.js";

const params = requireProvided("fastCheck", inject("fastCheck"));
// #200: the timeout scales with the run count; Vitest resets it after this file.
vi.setConfig({ testTimeout: inject("propertyTimeout") });

const registries: readonly (readonly [string, Registry, readonly Recording[]])[] = [
	["the game's registry", registry, recordings],
	["a registry with a version upgrade", twoVersions, [recordLogs(twoVersions, 1, params)]],
];

describe.each(registries)("the rules-version check, over %s", (_name, checked, recorded) => {
	const versions = createVersions(checked);
	const all = listVersions(checked);
	const released = all.flatMap(({ contentHash }, i) => (contentHash === null ? [] : [i + 1]));
	/** Every version but the current one has a version upgrade after it. */
	const upgradable = all.slice(0, -1).map((_version, i) => i + 1);

	it("has a recording for each released version, and for no other", () => {
		expect(recorded.map(({ rulesVersion }) => rulesVersion)).toEqual(released);
		expect(recorded.every(({ logs }) => logs.length > 0)).toBe(true);
	});

	it("1: every released version's content still hashes to its recorded hash", () => {
		expect(listFrozenFaults(checked)).toEqual([]);
	});

	it("2: every recorded log replays on today's code to each row's hash and the final farm's", () => {
		expect(recorded.flatMap((recording) => listReplayFaults(checked, recording))).toEqual([]);
	});

	it.each(upgradable)(
		"3: farms of version %i upgrade to the next and the current version without a throw, within MUST-14's bounds, as plain JSON, keeping shared facts",
		(version) => {
			const sim = versions.getSim(version);
			fc.assert(
				fc.property(farmId, timedActions, fc.nat(), (id, played, pick) => {
					// One farm of each run, often mid-run with work in flight: every farm of a run took
					// over the property timeout at 1,000 runs.
					const { farms } = play(sim, id, played);
					const farm = farms[pick % farms.length] ?? sim.newFarm(id);
					expect(listUpgradeFaults(checked, version, farm)).toEqual([]);
				}),
				params,
			);
		},
	);

	it.each(recorded)(
		"4: version $rulesVersion's logs, continued under the current version, end on one farm from the first action or from a base snapshot",
		({ rulesVersion, logs }) => {
			fc.assert(
				fc.property(fc.constantFrom(...logs), timedActions, (log, played) => {
					expect(listBoundaryFaults(checked, rulesVersion, log, played)).toEqual([]);
				}),
				params,
			);
		},
	);
});
