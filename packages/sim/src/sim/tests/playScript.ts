// The determinism gate's pure side (#48): ADR-0001's step 0 as one process runs it. The script
// plays from a new farm twice, each time through a fresh sim, and replays from JSON snapshots. The
// gate (.github/scripts/determinism-gate.mjs) runs this in two processes and compares their hashes
// with each other and with the recorded one; a test file may not start processes (#81).
import { createSim, sliceContent, stateHash } from "../../index.js";
import type { Action, FarmState, Sim } from "../../index.js";

/** One step of a recorded script: an action and the server time it is sent at. */
export interface ScriptStep {
	readonly action: Action;
	readonly at: number;
}

/** A recorded action script: the farm it plays and its steps, accepted or not, in time order. */
export interface Script {
	readonly farmId: string;
	readonly steps: readonly ScriptStep[];
}

/** What one process saw: the final state hash, the counts, and any disagreement inside it. */
export interface ScriptRun {
	readonly hash: string;
	readonly accepted: number;
	readonly refused: number;
	/**
	 * Whether each random stream drew at least once, so the script reached randomness
	 * (ADR-0003, section 7, D9).
	 */
	readonly streamsMoved: { readonly yields: boolean; readonly orders: boolean };
	/** Whether work was in progress when the script's longest gap began (`isBusy`). */
	readonly isGapBusy: boolean;
	readonly problems: readonly string[];
	/**
	 * The final farm itself, so the gate can also compare its plain JSON: "the same farm" mustn't
	 * rest only on `stateHash`, which a PR can change without the admin (#48's review).
	 */
	readonly final: FarmState;
}

/**
 * ADR-0001 kept snapshots every 1, 25 and 100 actions. Replaying from every 25th seq covers the
 * 25 and 100 cases; at N = 1 a load reads the latest snapshot, which has nothing left to replay.
 */
const snapshotEvery = 25;

/** Plays `script` on the sims `makeSim` returns (the slice's by default) and checks it agrees. */
export function playScript(
	script: Script,
	makeSim: () => Sim = () => createSim(sliceContent),
): ScriptRun {
	const sim = makeSim();
	const first = play(sim, script);
	const hash = stateHash(first.final);
	const problems: string[] = [];
	if (!isSameFarm(play(makeSim(), script).final, first.final)) {
		problems.push("The second play in this process ended on another farm.");
	}

	for (let seq = 0; seq < first.log.length; seq += snapshotEvery) {
		problems.push(...replayFrom(sim, first, seq));
	}

	const start = sim.newFarm(script.farmId).streams;
	return {
		hash,
		accepted: first.log.length,
		refused: script.steps.length - first.log.length,
		streamsMoved: {
			yields: first.final.streams.yields !== start.yields,
			orders: first.final.streams.orders !== start.orders,
		},
		isGapBusy: first.isGapBusy,
		problems,
		final: first.final,
	};
}

/** Two crops still growing at `at` and a job running: work the gap's offline progress finishes. */
export function isBusy(farm: FarmState, at: number): boolean {
	const growing = farm.plots.filter((p) => p.status === "growing" && p.readyAt > at);
	const jobs = farm.facilities.flatMap((f) => f?.jobs ?? []);
	return growing.length >= 2 && jobs.some((job) => job.status === "running");
}

interface Played {
	readonly final: FarmState;
	/** The accepted steps: entry i is seq i + 1. */
	readonly log: readonly ScriptStep[];
	/** The farm as JSON after each seq, the new farm at 0, as a store would keep it. */
	readonly snapshots: readonly string[];
	readonly isGapBusy: boolean;
}

/** Plays every step from a new farm; a refused step leaves no trace (`GLOSSARY.md`, "Action"). */
function play(sim: Sim, script: Script): Played {
	let farm = sim.newFarm(script.farmId);
	const log: ScriptStep[] = [];
	const snapshots = [JSON.stringify(farm)];
	const gapAt = findLongestGap(script.steps);
	let isGapBusy = false;
	for (const [i, step] of script.steps.entries()) {
		if (i === gapAt) isGapBusy = isBusy(farm, script.steps[i - 1]?.at ?? 0);
		const result = sim.apply(farm, step.action, step.at);
		if (!result.ok) continue;

		farm = result.state;
		log.push(step);
		snapshots.push(JSON.stringify(farm));
	}
	return { final: farm, log, snapshots, isGapBusy };
}

/** The index of the step after the longest wait between two steps, or -1 with fewer than two. */
function findLongestGap(steps: readonly ScriptStep[]): number {
	let longest = -1;
	let wait = -1;
	for (const [i, step] of steps.entries()) {
		const since = step.at - (steps[i - 1]?.at ?? step.at);
		if (i > 0 && since > wait) [longest, wait] = [i, since];
	}
	return longest;
}

/** The same state hash and the same plain JSON. */
function isSameFarm(a: FarmState, b: FarmState): boolean {
	return stateHash(a) === stateHash(b) && JSON.stringify(a) === JSON.stringify(b);
}

/** Replays the log after the snapshot at `seq` and compares the farm it ends on with the final one. */
function replayFrom(sim: Sim, played: Played, seq: number): string[] {
	const snapshot = played.snapshots[seq];
	if (snapshot === undefined) throw new RangeError(`There is no snapshot at seq ${String(seq)}.`);

	let farm = JSON.parse(snapshot) as FarmState;
	for (const [i, { action, at }] of played.log.slice(seq).entries()) {
		const result = sim.apply(farm, action, at);
		if (!result.ok) {
			return [`Replay from the snapshot at seq ${String(seq)} refused seq ${String(seq + i + 1)}.`];
		}

		farm = result.state;
	}
	return isSameFarm(farm, played.final)
		? []
		: [`Replay from the snapshot at seq ${String(seq)} ended on another farm.`];
}
