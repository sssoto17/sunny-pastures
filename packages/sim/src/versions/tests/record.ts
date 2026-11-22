// Recording a released rules version's logs (ADR-0006, section 10, "Recorded logs"): the property
// harness's generator, at a fixed seed, plays a set of farms under the version, and each log keeps
// the state hash after every row and after an offline day. `scripts/record-rules-version.mjs` runs
// this when a version is released; the rules-version check replays the recording ever after.
import fc from "fast-check";

import { stateHash } from "../../index.js";
import type { Action } from "../../index.js";
import { play, timedActions } from "../../state/tests/farms.js";
import type { TimedAction } from "../../state/tests/farms.js";
import { createVersions } from "../index.js";
import type { Registry } from "../index.js";

/** The logs recorded for one released version. */
export interface Recording {
	readonly rulesVersion: number;
	readonly logs: readonly RecordedLog[];
}

/** One farm's log under the recording's version, with the hashes today's code must still reach. */
export interface RecordedLog {
	readonly farmId: string;
	/** Seq 1, 2, 3 in order, each with the state hash of the farm after it (its answer's hash). */
	readonly rows: readonly RecordedRow[];
	/** A server time after the last row: the farm advanced to it offline hashes to `hash`. */
	readonly to: number;
	readonly hash: string;
}

export interface RecordedRow {
	readonly seq: number;
	readonly at: number;
	readonly action: Action;
	readonly hash: string;
}

/** The generated runs a version records; runs the rules accept no action of aren't kept. */
const runs = 8;
/** The offline time after each log's last row, so the recording covers `advance` too. */
const offlineMs = 24 * 3_600_000;

/**
 * Records `rulesVersion`'s logs from the first runs `settings` samples: the same recording every
 * time for the same content and seed. Tests pass `inject("fastCheck")`; the recording script passes
 * the root config's fixed seed.
 */
export function recordLogs(
	registry: Registry,
	rulesVersion: number,
	settings: fc.Parameters<TimedAction[]>,
): Recording {
	const sim = createVersions(registry).simOf(rulesVersion);
	const sampled = fc.sample(timedActions, settings).slice(0, runs);
	const logs = sampled.flatMap((played, i) => {
		const farmId = `recorded-v${String(rulesVersion)}-${String(i + 1)}`;
		const { transitions, final } = play(sim, farmId, played);
		if (transitions.length === 0) return [];

		const rows = transitions.map(({ action, at, after }, j) => ({
			seq: j + 1,
			at,
			action,
			hash: stateHash(after),
		}));
		const to = final.time + offlineMs;
		return [{ farmId, rows, to, hash: stateHash(sim.advance(final, to)) }];
	});
	return { rulesVersion, logs };
}
