import { describe, expect, it } from "vitest";

import { evaluate } from "../determinism-gate.mjs";

const hash = "a".repeat(64);
const other = "b".repeat(64);
const hour = 3_600_000;
// 500 steps 10 s apart, with the 8-hour gap before step 250.
const script = {
	farmId: "gate",
	steps: Array.from({ length: 500 }, (_, i) => ({
		action: { type: "harvest", plot: 0 },
		at: i * 10_000 + (i >= 250 ? 8 * hour : 0),
	})),
};
const run = (overrides = {}) => ({
	label: "process 1",
	hash,
	jsonHash: "c".repeat(64),
	accepted: 450,
	refused: 50,
	streamsMoved: { yields: true, orders: true },
	isGapBusy: true,
	problems: [],
	...overrides,
});

describe("determinism gate", () => {
	it("passes when both processes and the recorded hash agree", () => {
		const { failures, report } = evaluate({ script, runs: [run(), run()], expected: hash });

		expect(failures).toEqual([]);
		expect(report).toContain(`process 1: 450 accepted, 50 refused, state hash ${hash}`);
	});

	it("fails when the two processes end on different state hashes", () => {
		const { failures } = evaluate({
			script,
			runs: [run(), run({ hash: other })],
			expected: hash,
		});

		expect(failures).toEqual([expect.stringContaining("two processes ended on different")]);
	});

	it("fails when the processes' farms differ in plain JSON though their state hashes agree", () => {
		const { failures } = evaluate({
			script,
			runs: [run(), run({ jsonHash: "d".repeat(64) })],
			expected: hash,
		});

		expect(failures).toEqual([expect.stringContaining("two processes ended on different")]);
	});

	it("fails when both processes agree on a hash that isn't the recorded one", () => {
		const { failures } = evaluate({ script, runs: [run(), run()], expected: other });

		expect(failures).toEqual([expect.stringContaining("--update")]);
	});

	it("fails when no hash is recorded", () => {
		const { failures } = evaluate({ script, runs: [run(), run()], expected: null });

		expect(failures).toEqual([expect.stringContaining("no expected state hash")]);
	});

	it("fails on a problem a process found inside itself", () => {
		const { failures } = evaluate({
			script,
			runs: [run({ problems: ["The second play ended on another state hash."] }), run()],
			expected: hash,
		});

		expect(failures).toEqual(["process 1: The second play ended on another state hash."]);
	});

	it("fails a script the rules now accept too little of", () => {
		const { failures } = evaluate({
			script,
			runs: [run({ accepted: 399 }), run()],
			expected: hash,
		});

		expect(failures).toEqual([expect.stringContaining("accept 399 of the script's steps")]);
	});

	it("fails a script too short, without the gap, refusals or random draws to test", () => {
		const short = { ...script, steps: script.steps.slice(0, 100) };
		const { failures } = evaluate({
			script: short,
			runs: [
				run({ refused: 0, isGapBusy: false, streamsMoved: { yields: true, orders: false } }),
				run(),
			],
			expected: hash,
		});

		expect(failures).toEqual([
			"the script has 100 steps, not 500",
			"the script has no gap of 8 hours between two steps",
			"no work is in progress when the script's 8-hour gap begins",
			"the rules refuse 0 of the script's steps, fewer than 10",
			"the script never draws from the orders stream",
		]);
	});
});
