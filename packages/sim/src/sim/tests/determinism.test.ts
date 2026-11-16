// The determinism gate's pure side (#48, ADR-0001 step 0): what one process plays. The two-process
// comparison and the expected hash are .github/scripts/determinism-gate.mjs's.
import { describe, expect, it } from "vitest";

import { createSim, sliceContent } from "../../index.js";
import type { Sim } from "../../index.js";
import { isBusy, playScript } from "./playScript.js";
import type { Script } from "./playScript.js";
import { recordScript } from "./recordScript.js";

const script: Script = {
	farmId: "gate-test",
	steps: [
		{ action: { type: "plant", plot: 0, crop: "wheat" }, at: 1_000 },
		{ action: { type: "plant", plot: 0, crop: "wheat" }, at: 2_000 },
		{ action: { type: "harvest", plot: 0 }, at: 200_000 },
		{ action: { type: "plant", plot: 1, crop: "wheat" }, at: 100_000 },
	],
};

/** A sim that leaks state between plays: every farm it makes starts with one coin more. */
function makeLeakingSim(): () => Sim {
	let farms = 0;
	return () => {
		const sim = createSim(sliceContent);
		return {
			...sim,
			newFarm: (farmId) => {
				farms += 1;
				return { ...sim.newFarm(farmId), coins: sim.newFarm(farmId).coins + farms };
			},
		};
	};
}

describe("playScript", () => {
	it("counts the steps the rules accept and refuse, and finds no problem", () => {
		const run = playScript(script);

		expect(run).toMatchObject({ accepted: 2, refused: 2, problems: [] });
		expect(run.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("gives the same hash every time it plays the same script", () => {
		expect(playScript(script).hash).toBe(playScript(script).hash);
	});

	it("reports a sim whose second play in the process ends on another hash", () => {
		expect(playScript(script, makeLeakingSim()).problems).toEqual([
			expect.stringContaining("second play"),
		]);
	});

	it("reports a sim that keeps state outside the farm, which a JSON snapshot loses", () => {
		const sim = createSim(sliceContent);
		const made = new WeakSet();
		const hiding: Sim = {
			...sim,
			newFarm: (farmId) => {
				const farm = sim.newFarm(farmId);
				made.add(farm);
				return farm;
			},
			apply: (state, action, at) => {
				// Pays a coin only on farms this object made, which a snapshot's farm never is.
				const result = sim.apply(
					made.has(state) ? { ...state, coins: state.coins + 1 } : state,
					action,
					at,
				);
				if (result.ok) made.add(result.state);
				return result;
			},
		};

		expect(playScript(script, () => hiding).problems).toEqual([
			expect.stringContaining("snapshot"),
		]);
	});

	it("tells whether the farm's random streams moved from the new farm's", () => {
		expect(playScript(script).streamsMoved).toEqual({ yields: true, orders: false });
	});
});

describe("recordScript", () => {
	const recorded = recordScript();
	const hour = 3_600_000;
	/** The index of the first step after the 8-hour gap, or -1. */
	const gapAt = recorded.steps.findIndex(
		(step, i) => i > 0 && step.at - (recorded.steps[i - 1]?.at ?? 0) >= 8 * hour,
	);

	it("records 500 steps in time order, with an 8-hour gap after step 250", () => {
		const times = recorded.steps.map((step) => step.at);

		expect(times).toHaveLength(500);
		expect(times).toEqual([...times].sort((a, b) => a - b));
		expect(gapAt).toBeGreaterThanOrEqual(250);
	});

	it("records a script that sends refused actions, reaches both random streams and agrees", () => {
		const run = playScript(recorded);

		expect(run.refused).toBeGreaterThanOrEqual(10);
		expect(run.accepted).toBeGreaterThanOrEqual(400);
		expect(run.streamsMoved).toEqual({ yields: true, orders: true });
		expect(run.problems).toEqual([]);
	});

	it("starts the gap with crops growing and a job running, so offline progress has steps", () => {
		const sim = createSim(sliceContent);
		const beforeGap = recorded.steps.slice(0, gapAt).reduce((farm, { action, at }) => {
			const result = sim.apply(farm, action, at);
			return result.ok ? result.state : farm;
		}, sim.newFarm(recorded.farmId));

		expect(isBusy(beforeGap, recorded.steps[gapAt - 1]?.at ?? 0)).toBe(true);
		expect(playScript(recorded).isGapBusy).toBe(true);
	});

	it("records the same script every time", () => {
		expect(recordScript()).toEqual(recorded);
	});
});
